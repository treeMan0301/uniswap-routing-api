import Joi from '@hapi/joi';
import { metricScope, MetricsLogger } from 'aws-embedded-metrics';
import {
  APIGatewayProxyEvent,
  APIGatewayProxyHandler,
  APIGatewayProxyResult,
  Context,
} from 'aws-lambda';
import { default as bunyan, default as Logger } from 'bunyan';

export type BaseRInj = {
  log: Logger;
};

export type HandleRequestParams<CInj, RInj, Req> = {
  context: Context;
  event: APIGatewayProxyEvent;
  request: Req;
  containerInjected: CInj;
  requestInjected: RInj;
};

export type Response<Res> = {
  statusCode: 200 | 202;
  body: Res;
};

export type ErrorResponse = {
  statusCode: 400 | 403 | 404 | 408 | 409 | 500;
  errorCode: string;
  detail?: string;
};

export abstract class Injector<CInj, RInj extends BaseRInj, Req> {
  private containerInjected: CInj;
  public constructor() {}

  public async build() {
    this.containerInjected = await this.buildContainerInjected();
    return this;
  }

  public abstract getRequestInjected(
    containerInjected: CInj,
    request: Req,
    event: APIGatewayProxyEvent,
    context: Context,
    log: Logger,
    metrics: MetricsLogger
  ): Promise<RInj>;

  public abstract buildContainerInjected(): Promise<CInj>;

  public async getContainerInjected(): Promise<CInj> {
    if (this.containerInjected === undefined) {
      throw new Error(
        'Container injected undefined. Must call build() before using.'
      );
    }
    return this.containerInjected;
  }
}

const INTERNAL_ERROR: APIGatewayProxyResult = {
  statusCode: 500,
  body: JSON.stringify({
    errorCode: 'INTERNAL_ERROR',
    detail: 'Unexpected error.',
  }),
};

export abstract class APIGLambdaHandler<CInj, RInj extends BaseRInj, Req, Res> {
  constructor(
    private handlerName: string,
    private injector: Injector<CInj, RInj, Req>
  ) {}

  get handler(): APIGatewayProxyHandler {
    return metricScope(
      (metric: MetricsLogger) =>
        async (
          event: APIGatewayProxyEvent,
          context: Context
        ): Promise<APIGatewayProxyResult> => {
          let log: Logger = bunyan.createLogger({
            name: this.handlerName,
            serializers: bunyan.stdSerializers,
            level: bunyan.INFO,
            requestId: context.awsRequestId,
          });

          log.info({ event, context }, 'Request started.');

          let request: Req;
          try {
            const requestValidation = await this.parseAndValidateRequest(event);

            if (requestValidation.state == 'invalid') {
              return requestValidation.errorResponse;
            }

            request = requestValidation.request;
          } catch (err) {
            log.error({ err }, 'Unexpected error validating request');
            return INTERNAL_ERROR;
          }

          const containerInjected = await this.injector.getContainerInjected();

          let requestInjected: RInj;
          try {
            requestInjected = await this.injector.getRequestInjected(
              containerInjected,
              request,
              event,
              context,
              log,
              metric
            );
          } catch (err) {
            log.error({ err, event }, 'Error building request injected.');
            return INTERNAL_ERROR;
          }

          ({ log } = requestInjected);

          let statusCode: number;
          let body: Res;

          log.info({ request }, 'Invoking handle request');
          try {
            const handleRequestResult = await this.handleRequest({
              context,
              event,
              request,
              containerInjected,
              requestInjected,
            });

            if (this.isError(handleRequestResult)) {
              const { statusCode, detail, errorCode } = handleRequestResult;
              return {
                statusCode,
                body: JSON.stringify({ detail, errorCode }),
              };
            } else {
              ({ body, statusCode } = handleRequestResult);
            }
          } catch (err) {
            log.error({ err }, 'Unexpected error in handler');
            return INTERNAL_ERROR;
          }

          let response: Res;
          try {
            const responseValidation = await this.parseAndValidateResponse(
              body
            );

            if (responseValidation.state == 'invalid') {
              return responseValidation.errorResponse;
            }

            response = responseValidation.response;
          } catch (err) {
            log.error({ err }, 'Unexpected error in handler');
            return INTERNAL_ERROR;
          }

          return { statusCode, body: JSON.stringify(response) };
        }
    );
  }

  public abstract handleRequest(
    params: HandleRequestParams<CInj, RInj, Req>
  ): Promise<Response<Res> | ErrorResponse>;

  protected abstract requestBodySchema(): Joi.ObjectSchema | null;
  protected abstract responseBodySchema(): Joi.ObjectSchema | null;

  private isError(
    result: Response<Res> | ErrorResponse
  ): result is ErrorResponse {
    return result.statusCode != 200 && result.statusCode != 202;
  }

  private async parseAndValidateRequest(
    event: APIGatewayProxyEvent
  ): Promise<
    | { state: 'valid'; request: Req }
    | { state: 'invalid'; errorResponse: APIGatewayProxyResult }
  > {
    let body: any;
    try {
      body = JSON.parse(event.body ?? '');
    } catch (err) {
      return { state: 'invalid', errorResponse: { statusCode: 422, body: '' } };
    }

    const bodySchema = this.requestBodySchema();

    if (!bodySchema) {
      return { state: 'valid', request: body as Req };
    }

    const res = bodySchema.validate(body, {
      allowUnknown: true, // Makes API schema changes and rollbacks easier.
      stripUnknown: true,
    });

    if (res.error) {
      return {
        state: 'invalid',
        errorResponse: { statusCode: 400, body: res.error.message },
      };
    }

    return { state: 'valid', request: res.value as Req };
  }

  private async parseAndValidateResponse(
    body: Res
  ): Promise<
    | { state: 'valid'; response: Res }
    | { state: 'invalid'; errorResponse: APIGatewayProxyResult }
  > {
    const responseSchema = this.responseBodySchema();

    if (!responseSchema) {
      return { state: 'valid', response: body as Res };
    }

    const res = responseSchema.validate(body, {
      allowUnknown: true,
      stripUnknown: true, // Ensure no unexpected fields returned to users.
    });

    if (res.error) {
      return {
        state: 'invalid',
        errorResponse: { statusCode: 500, body: 'Internal error' },
      };
    }

    return { state: 'valid', response: res.value as Res };
  }
}
