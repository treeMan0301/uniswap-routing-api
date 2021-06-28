import { EventBridgeEvent, ScheduledHandler } from 'aws-lambda';
import bunyan from 'bunyan';
import Logger from 'bunyan';
import { request, gql } from 'graphql-request';
import { S3 } from 'aws-sdk';

const SUBGRAPH_URL =
  'https://api.thegraph.com/subgraphs/name/uniswap/uniswap-v3';

export type SubgraphPool = {
  id: string;
  feeTier: string;
  liquidity: string;
  token0: {
    symbol: string;
  };
  token1: {
    symbol: string;
  };
  totalValueLockedETH: string;
};

const handler: ScheduledHandler = async (
  event: EventBridgeEvent<string, void>
) => {
  const log: Logger = bunyan.createLogger({
    name: 'RoutingLambda',
    serializers: bunyan.stdSerializers,
    level: 'info',
    requestId: event.id,
  });

  const PAGE_SIZE = 1000;

  const query = gql`
    query getPools($pageSize: Int!, $skip: Int!) {
      pools(
        first: $pageSize
        skip: $skip
        orderBy: totalValueLockedETH
        orderDirection: desc
      ) {
        id
        token0 {
          symbol
        }
        token1 {
          symbol
        }
        feeTier
        liquidity
        totalValueLockedETH
      }
    }
  `;

  let skip = 0;
  let pools: SubgraphPool[] = [];
  let poolsPage: SubgraphPool[] = [];

  log.info(`Getting pools from the subgraph with page size ${PAGE_SIZE}.`);

  do {
    const poolsResult = await request<{ pools: SubgraphPool[] }>(
      SUBGRAPH_URL,
      query,
      {
        pageSize: PAGE_SIZE,
        skip,
      }
    );

    poolsPage = poolsResult.pools;

    pools = pools.concat(poolsPage);
    skip = skip + PAGE_SIZE;
  } while (poolsPage.length > 0);

  const s3 = new S3();
  if (!pools || pools.length == 0) {
    return;
  }
  log.info(
    `Got ${pools.length} pools from the subgraph. Saving to ${process.env.POOL_CACHE_BUCKET}/${process.env.POOL_CACHE_KEY}`
  );

  await s3
    .putObject({
      Bucket: process.env.POOL_CACHE_BUCKET!,
      Key: process.env.POOL_CACHE_KEY!,
      Body: JSON.stringify(pools),
    })
    .promise();
};

module.exports = { handler };
