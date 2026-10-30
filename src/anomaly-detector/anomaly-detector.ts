import {
  CloudWatchLogsClient,
  StartQueryCommand,
  GetQueryResultsCommand,
} from "@aws-sdk/client-cloudwatch-logs";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, PutCommand } from "@aws-sdk/lib-dynamodb";

const LOG_GROUP_NAME = process.env.GATEWAY_LOG_GROUP_NAME!;
const ANOMALY_TABLE_NAME = process.env.ANOMALY_FLAGS_TABLE_NAME!;
const WINDOW_MINUTES = 5;

// A client is flagged if, within the window, it made at least this many
// requests, or at least this fraction of its requests were rate-limited.
const REQUEST_COUNT_THRESHOLD = 50;
const RATE_LIMIT_RATIO_THRESHOLD = 0.5;

const logsClient = new CloudWatchLogsClient({});
const dynamoClient = DynamoDBDocumentClient.from(new DynamoDBClient({}));


// This interface represents the statistics for a client within a given time window 
interface ClientWindowStats {
  identity: string;
  totalRequests: number;
  rateLimitedRequests: number;
}


// This Lambda function scans the cloudewatch logs for recent traffic and flags clients that are anamalous based on the defined thresholds. 
export const handler = async (): Promise<void> => {
  // Determine the time window for analysis
  const nowMs = Date.now();
  // The start of the window is WINDOW_MINUTES minutes ago
  const windowStartMs = nowMs - WINDOW_MINUTES * 60 * 1000;

  // Query recent traffic from CloudWatch Logs and identify anomalous clients
  const stats = await queryRecentTraffic(windowStartMs, nowMs);
  // Filter the stats to find clients that are anomalous based on the defined thresholds.
  const flagged = stats.filter(isAnomalous);

  // Record flagged clients in DynamoDB
  for (const client of flagged) {
    await recordFlag(client, windowStartMs, nowMs);
  }

  console.log(
    `anomaly-detector: scanned ${stats.length} clients, flagged ${flagged.length}`,
  );
};

async function queryRecentTraffic(
  startMs: number,
  endMs: number,
): Promise<ClientWindowStats[]> {
  const query = `
    fields identity, rateLimited
    | filter @message like /request completed/
  `;

  // Start the Logs Insights query and wait for it to complete
  const startResponse = await logsClient.send(
    new StartQueryCommand({
      logGroupName: LOG_GROUP_NAME,
      startTime: Math.floor(startMs / 1000),
      endTime: Math.floor(endMs / 1000),
      queryString: query,
      limit: 10000,
    }),
  );

  // Poll for the query results until the query completes or fails
  const queryId = startResponse.queryId!;
  const rows = await pollQueryResults(queryId);

  // Aggregate the results by client identity, counting total requests and rate-limited requests.
  const byIdentity = new Map<string, ClientWindowStats>();
  for (const row of rows) {
    const identity = row.find((f) => f.field === "identity")?.value;
    const rateLimited = row.find((f) => f.field === "rateLimited")?.value;
    if (!identity) continue;

    const entry = byIdentity.get(identity) ?? {
      identity,
      totalRequests: 0,
      rateLimitedRequests: 0,
    };
    entry.totalRequests += 1;
    if (rateLimited === "true") entry.rateLimitedRequests += 1;
    byIdentity.set(identity, entry);
  }

  return Array.from(byIdentity.values());
}


// Polls the Logs Insights query results until the query completes or fails, 
// returning the results as an array of rows, where each row is an array of field-value pairs.
async function pollQueryResults(
  queryId: string,
): Promise<{ field?: string; value?: string }[][]> {
  // Logs Insights queries are async — poll until the query finishes.
  for (let attempt = 0; attempt < 10; attempt++) {
    const result = await logsClient.send(
      new GetQueryResultsCommand({ queryId }),
    );

    if (result.status === "Complete") {
      return (result.results ?? []).map((row) =>
        row.map((f) => ({ field: f.field, value: f.value })),
      );
    }

    if (result.status === "Failed" || result.status === "Cancelled") {
      throw new Error(`Logs Insights query ${result.status}`);
    }

    await new Promise((resolve) => setTimeout(resolve, 1000));
  }

  throw new Error("Logs Insights query did not complete in time");
}

function isAnomalous(stats: ClientWindowStats): boolean {
  if (stats.totalRequests >= REQUEST_COUNT_THRESHOLD) return true;

  const ratio = stats.rateLimitedRequests / stats.totalRequests;
  return ratio >= RATE_LIMIT_RATIO_THRESHOLD;
}

// Records a flagged client in DynamoDB with the reason for flagging, the total requests, 
// rate-limited requests, and timestamps for the window start and detection time.
async function recordFlag(
  client: ClientWindowStats,
  windowStartMs: number,
  detectedAtMs: number,
): Promise<void> {
  const reason =
    client.totalRequests >= REQUEST_COUNT_THRESHOLD
      ? "high_request_volume"
      : "high_rate_limit_ratio";

  await dynamoClient.send(
    new PutCommand({
      TableName: ANOMALY_TABLE_NAME,
      Item: {
        identity: client.identity,
        reason,
        totalRequests: client.totalRequests,
        rateLimitedRequests: client.rateLimitedRequests,
        windowStart: new Date(windowStartMs).toISOString(),
        detectedAt: new Date(detectedAtMs).toISOString(),
      },
    }),
  );
}
