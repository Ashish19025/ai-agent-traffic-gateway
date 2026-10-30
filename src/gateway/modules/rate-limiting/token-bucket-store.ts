import { ConditionalCheckFailedException, DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, GetCommand, PutCommand } from "@aws-sdk/lib-dynamodb";
import {
  consumeToken,
  createInitialState,
  type BucketPolicy,
  type ConsumeResult,
} from "./token-bucket.js";

const TABLE_NAME = process.env.RATE_LIMIT_TABLE_NAME ?? "rate-limit-buckets";
const MAX_RETRIES = 5;

const client = DynamoDBDocumentClient.from(new DynamoDBClient({}));

/**
 * The DynamoDB-backed version of consumeToken: same algorithm, but the
 * BucketState now lives in a table instead of a JS variable, because a
 * Lambda can't rely on memory surviving between invocations.
 *
 * Table shape: partition key `clientId` (string), plus the two fields
 * from BucketState (`tokens`, `lastRefillMs`) stored directly as item
 * attributes — one row per client, nothing more.
 *
 * Why the retry loop: DynamoDB can't run our TS `consumeToken` logic
 * server-side, so we can't do the whole read-check-write atomically in
 * one call like a Lua script in Redis would. Instead we use optimistic
 * concurrency: write back only if nobody else changed the item since we
 * read it (checked via `lastRefillMs`, which changes on every write).
 * If another concurrent request won the race, our write is rejected and
 * we retry with a fresh read — this is what actually closes the race
 * window the plain Get-then-Put version had.
 */
export async function consumeTokenForClient(
  clientId: string,
  policy: BucketPolicy,
  nowMs: number,
): Promise<ConsumeResult> {
  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    const existing = await client.send(
      new GetCommand({
        TableName: TABLE_NAME,
        Key: { clientId },
      }),
    );

    const previousLastRefillMs = existing.Item?.lastRefillMs as number | undefined;
    const state = existing.Item
      ? { tokens: existing.Item.tokens as number, lastRefillMs: previousLastRefillMs as number }
      : createInitialState(policy, nowMs);

    const result = consumeToken(state, policy, nowMs);

    try {
      await client.send(
        new PutCommand({
          TableName: TABLE_NAME,
          Item: {
            clientId,
            tokens: result.state.tokens,
            lastRefillMs: result.state.lastRefillMs,
          },
          ConditionExpression: previousLastRefillMs === undefined
            ? "attribute_not_exists(clientId)"
            : "lastRefillMs = :expected",
          ExpressionAttributeValues: previousLastRefillMs === undefined
            ? undefined
            : { ":expected": previousLastRefillMs },
        }),
      );
      return result;
    } catch (error) {
      if (error instanceof ConditionalCheckFailedException) {
        continue;
      }
      throw error;
    }
  }

  throw new Error(`consumeTokenForClient: exceeded ${MAX_RETRIES} retries for client "${clientId}"`);
}
