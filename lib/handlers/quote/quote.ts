import Joi from '@hapi/joi';
import {
  Currency,
  CurrencyAmount,
  Ether,
  Percent,
  TradeType,
} from '@uniswap/sdk-core';
import {
  AlphaRouterConfig,
  ChainId,
  ITokenListProvider,
  ITokenProvider,
  MetricLoggerUnit,
  routeAmountsToString,
  SwapConfig,
  SwapRoute,
} from '@uniswap/smart-order-router';
import Logger from 'bunyan';
import JSBI from 'jsbi';
import {
  APIGLambdaHandler,
  ErrorResponse,
  HandleRequestParams,
  Response,
} from '../handler';
import { ContainerInjected, RequestInjected } from './injector';
import {
  EdgeInRoute,
  NodeInRoute,
  QuoteQueryParams,
  QuoteQueryParamsJoi,
  QuoteResponse,
  QuoteResponseSchemaJoi,
} from './schema/quote-schema';

const ROUTING_CONFIG: AlphaRouterConfig = {
  topN: 3,
  topNTokenInOut: 3,
  topNSecondHop: 0,
  topNWithEachBaseToken: 2,
  topNWithBaseToken: 6,
  topNWithBaseTokenInSet: true,
  maxSwapsPerPath: 3,
  maxSplits: 3,
  distributionPercent: 5,
  // Multicall is parameterized to consume max 750k gas.
  // Some providers like Infura set a gas limit per call of 10x block gas
  // limit i.e. ~ 150m. 175*750k < 150m
  multicallChunkSize: 175,
};

export class QuoteHandler extends APIGLambdaHandler<
  ContainerInjected,
  RequestInjected,
  void,
  QuoteQueryParams,
  QuoteResponse
> {
  public async handleRequest(
    params: HandleRequestParams<
      ContainerInjected,
      RequestInjected,
      void,
      QuoteQueryParams
    >
  ): Promise<Response<QuoteResponse> | ErrorResponse> {
    const {
      requestQueryParams: {
        tokenInAddress,
        tokenInChainId,
        tokenOutAddress,
        tokenOutChainId,
        amount: amountRaw,
        type,
        recipient,
        slippageTolerance,
        deadline,
      },
      requestInjected: {
        router,
        log,
        quoteId,
        tokenProvider,
        poolProvider,
        metric,
      },
      containerInjected: { tokenListProvider },
    } = params;

    // Parse user provided token address/symbol to Currency object.
    const before = Date.now();

    const { currencyIn, currencyOut } = await this.tokenStringToCurrency(
      tokenListProvider,
      tokenProvider,
      tokenInAddress,
      tokenOutAddress,
      tokenInChainId,
      tokenOutChainId,
      log
    );

    metric.putMetric(
      'TokenInOutStrToToken',
      Date.now() - before,
      MetricLoggerUnit.Milliseconds
    );

    if (!currencyIn) {
      return {
        statusCode: 400,
        errorCode: 'TOKEN_IN_INVALID',
        detail: `Could not find token with address "${tokenInAddress}"`,
      };
    }

    if (!currencyOut) {
      return {
        statusCode: 400,
        errorCode: 'TOKEN_OUT_INVALID',
        detail: `Could not find token with address "${tokenOutAddress}"`,
      };
    }

    if (currencyIn.equals(currencyOut)) {
      return {
        statusCode: 400,
        errorCode: 'TOKEN_IN_OUT_SAME',
        detail: `tokenIn and tokenOut must be different`,
      };
    }

    let swapParams: SwapConfig | undefined = undefined;

    if (slippageTolerance && deadline && recipient) {
      const slippagePer10k = Math.round(parseFloat(slippageTolerance) * 100);
      const slippageTolerancePercent = new Percent(slippagePer10k, 10_000);
      swapParams = {
        deadline: Math.floor(Date.now() / 1000) + parseInt(deadline),
        recipient: recipient,
        slippageTolerance: slippageTolerancePercent,
      };
    }

    // e.g. Inputs of form "1.25%" with 2dp max. Convert to fractional representation => 1.25 => 125 / 10000
    let swapRoute: SwapRoute<TradeType> | null;
    switch (type) {
      case 'exactIn':
        const amountIn = CurrencyAmount.fromRawAmount(
          currencyIn,
          JSBI.BigInt(amountRaw)
        );

        log.info(
          {
            amountIn: amountIn.toExact(),
            currency: amountIn.currency.symbol,
            routingConfig: ROUTING_CONFIG,
          },
          `Exact In Swap: Give ${amountIn.toExact()} ${
            amountIn.currency.symbol
          }, Want: ${currencyOut.symbol}`
        );

        swapRoute = await router.routeExactIn(
          currencyIn,
          currencyOut,
          amountIn,
          swapParams,
          ROUTING_CONFIG
        );
        break;
      case 'exactOut':
        const amountOut = CurrencyAmount.fromRawAmount(
          currencyOut,
          JSBI.BigInt(amountRaw)
        );

        log.info(
          {
            amountIn: amountOut.toExact(),
            currency: amountOut.currency.symbol,
            routingConfig: ROUTING_CONFIG,
          },
          `Exact Out Swap: Want ${amountOut.toExact()} ${
            amountOut.currency.symbol
          } Give: ${currencyIn.symbol}`
        );

        swapRoute = await router.routeExactOut(
          currencyIn,
          currencyOut,
          amountOut,
          swapParams,
          ROUTING_CONFIG
        );
        break;
      default:
        throw new Error('');
    }

    if (!swapRoute) {
      return {
        statusCode: 404,
        errorCode: 'NO_ROUTE',
        detail: 'No route found',
      };
    }

    const {
      quote,
      quoteGasAdjusted,
      routeAmounts,
      estimatedGasUsed,
      estimatedGasUsedQuoteToken,
      estimatedGasUsedUSD,
      gasPriceWei,
      methodParameters,
      blockNumber,
    } = swapRoute;

    const nodes: NodeInRoute[] = [];
    const edges: EdgeInRoute[] = [];

    const tokenSet: Set<string> = new Set<string>();

    for (const routeAmount of routeAmounts) {
      const {
        route: { tokenPath, pools },
        amount,
        quote,
      } = routeAmount;

      let prevToken = tokenPath[0];

      if (!tokenSet.has(prevToken.address)) {
        tokenSet.add(prevToken.address);
        nodes.push({
          type: 'token',
          id: prevToken.address,
          chainId: prevToken.chainId,
          symbol: prevToken.symbol!,
          decimals: prevToken.decimals.toString()!
        });
      }

      for (let i = 0; i < pools.length; i++) {
        const nextPool = pools[i];
        const nextToken = tokenPath[i + 1];

        if (!tokenSet.has(nextToken.address)) {
          tokenSet.add(nextToken.address);
          nodes.push({
            type: 'token',
            id: nextToken.address,
            chainId: nextToken.chainId,
            symbol: nextToken.symbol!,
            decimals: prevToken.decimals.toString()!
          });
        }

        let edgeAmountIn = undefined;
        if (i == 0) {
          edgeAmountIn =
            type == 'exactIn'
              ? amount.quotient.toString()
              : quote.quotient.toString();
        }

        let edgeAmountOut = undefined;
        if (i == pools.length - 1) {
          edgeAmountOut =
            type == 'exactIn'
              ? quote.quotient.toString()
              : amount.quotient.toString();
        }

        edges.push({
          type: 'v3-pool',
          id: poolProvider.getPoolAddress(
            nextPool.token0,
            nextPool.token1,
            nextPool.fee
          ).poolAddress,
          inId: tokenPath[i].address,
          outId: nextToken.address,
          fee: nextPool.fee.toString(),
          liquidity: nextPool.liquidity.toString(),
          sqrtRatioX96: nextPool.sqrtRatioX96.toString(),
          tickCurrent: nextPool.tickCurrent.toString(),
          amountIn: edgeAmountIn,
          amountOut: edgeAmountOut,
        });

        prevToken = nextToken;
      }
    }

    const result: QuoteResponse = {
      methodParameters,
      blockNumber: blockNumber.toString(),
      quote: quote.quotient.toString(),
      quoteDecimals: quote.toExact(),
      quoteGasAdjusted: quoteGasAdjusted.quotient.toString(),
      quoteGasAdjustedDecimals: quoteGasAdjusted.toExact(),
      gasUseEstimateQuote: estimatedGasUsedQuoteToken.quotient.toString(),
      gasUseEstimateQuoteDecimals: estimatedGasUsedQuoteToken.toExact(),
      gasUseEstimate: estimatedGasUsed.toString(),
      gasUseEstimateUSD: estimatedGasUsedUSD.toExact(),
      gasPriceWei: gasPriceWei.toString(),
      routeNodes: nodes,
      routeEdges: edges,
      routeString: routeAmountsToString(routeAmounts),
      quoteId,
    };

    return {
      statusCode: 200,
      body: result,
    };
  }

  private async tokenStringToCurrency(
    tokenListProvider: ITokenListProvider,
    tokenProvider: ITokenProvider,
    tokenInRaw: string,
    tokenOutRaw: string,
    tokenInChainId: ChainId,
    tokenOutChainId: ChainId,
    log: Logger
  ): Promise<{
    currencyIn: Currency | undefined;
    currencyOut: Currency | undefined;
  }> {
    const isAddress = (s: string) => s.length == 42 && s.startsWith('0x');

    const tryTokenList = (
      tokenRaw: string,
      chainId: ChainId
    ): Currency | undefined => {
      if (
        tokenRaw == 'ETH' ||
        tokenRaw.toLowerCase() == '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee'
      ) {
        return Ether.onChain(chainId);
      }

      if (isAddress(tokenRaw)) {
        const token = tokenListProvider.getTokenByAddress(tokenRaw);

        return token;
      }

      return tokenListProvider.getTokenBySymbol(tokenRaw);
    };

    let currencyIn: Currency | undefined = tryTokenList(
      tokenInRaw,
      tokenInChainId
    );
    let currencyOut: Currency | undefined = tryTokenList(
      tokenOutRaw,
      tokenOutChainId
    );

    if (currencyIn && currencyOut) {
      log.info(
        {
          tokenInAddress: currencyIn.wrapped.address,
          tokenOutAddress: currencyOut.wrapped.address,
        },
        'Got both input tokens from token list'
      );
      return { currencyIn, currencyOut };
    }

    const tokensToFetch = [];
    if (!currencyIn && isAddress(tokenInRaw)) {
      tokensToFetch.push(tokenInRaw);
    }
    if (!currencyOut && isAddress(tokenOutRaw)) {
      tokensToFetch.push(tokenOutRaw);
    }

    log.info(`Getting tokens ${tokensToFetch} from chain`);
    const tokenAccessor = await tokenProvider.getTokens(tokensToFetch);

    if (!currencyIn) {
      currencyIn = tokenAccessor.getTokenByAddress(tokenInRaw);
    }
    if (!currencyOut) {
      currencyOut = tokenAccessor.getTokenByAddress(tokenOutRaw);
    }

    return { currencyIn, currencyOut };
  }

  protected requestBodySchema(): Joi.ObjectSchema | null {
    return null;
  }

  protected requestQueryParamsSchema(): Joi.ObjectSchema | null {
    return QuoteQueryParamsJoi;
  }

  protected responseBodySchema(): Joi.ObjectSchema | null {
    return QuoteResponseSchemaJoi;
  }
}
