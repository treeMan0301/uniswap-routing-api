import Joi from '@hapi/joi';
import { MethodParameters } from '@uniswap/v3-sdk';

export const QuoteBodySchemaJoi = Joi.object({
  tokenIn: Joi.string().alphanum().max(40).required(), // Support symbols or addresses
  tokenOut: Joi.string().alphanum().max(40).required(), // Support symbols or addresses
  amount: Joi.string().max(20).required(),
  chainId: Joi.number().valid(1).required(),
  type: Joi.string().valid('exactIn', 'exactOut').required(),
  recipient: Joi.string()
    .pattern(new RegExp('/^0x[a-fA-F0-9]{40}$/'))
    .required(),
  slippageTolerance: Joi.number().min(0).max(20).precision(2).required(),
  deadline: Joi.number().max(600).required(),
  algorithm: Joi.string().valid('alpha', 'legacy').optional(),
  inputTokenPermit: Joi.alternatives()
    .try(
      Joi.object({
        v: Joi.number().valid(0, 1, 27, 28).required(),
        r: Joi.string().max(256).required(),
        s: Joi.string().max(256).required(),
        amount: Joi.string().max(50).required(),
        deadline: Joi.number().max(600).required(),
      }),
      Joi.object({
        v: Joi.number().valid(0, 1, 27, 28).required(),
        r: Joi.string().max(256).required(),
        s: Joi.string().max(256).required(),
        nonce: Joi.string().max(50).required(),
        expiry: Joi.string().max(50).required(),
      })
    )
    .optional(),
});

export type QuoteBody = {
  tokenIn: string;
  tokenOut: string;
  type: string;
  amount: string;
  chainId: number;
  recipient: string;
  slippageTolerance: string;
  deadline: string;
  algorithm?: string;
  inputTokenPermit?:
    | {
        v: 0 | 1 | 27 | 28;
        r: string;
        s: string;
        amount: string;
        deadline: string;
      }
    | {
        v: 0 | 1 | 27 | 28;
        r: string;
        s: string;
        nonce: string;
        expiry: string;
      };
};

export type PoolInRoute = {
  type: 'pool';
  address: string;
  fee: string;
  token0Symbol: string;
  token1Symbol: string;
  token0Address: string;
  token1Address: string;
  nextToken: TokenInRoute;
};

export type TokenInRoute = {
  type: 'token';
  address: string;
  symbol: string;
  nextPools?: { [percentage: string]: PoolInRoute };
};

// export type RouteAmount = {
//   route: RouteSOR;
//   amount: CurrencyAmount; // Amount in or out from user.
//   quote: CurrencyAmount;
//   quoteGasAdjusted: CurrencyAmount;
//   estimatedGasUsed: BigNumber;
//   percentage: number;
// };

export type QuoteResponse = {
  blockNumber: string;
  gasUseEstimate: string;
  gasPriceWei: string;
  route: TokenInRoute;
  quote: string;
  quoteGasAdjusted: string;
  quoteId: string;
  methodParameters: MethodParameters;
};
