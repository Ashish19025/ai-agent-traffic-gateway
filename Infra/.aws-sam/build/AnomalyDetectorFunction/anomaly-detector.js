import { CloudWatchLogsClient, StartQueryCommand, GetQueryResultsCommand, } from "@aws-sdk/client-cloudwatch-logs";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, PutCommand } from "@aws-sdk/lib-dynamodb";
const LOG_GROUP_NAME = process.env.GATEWAY_LOG_GROUP_NAME;
const ANOMALY_TABLE_NAME = process.env.ANOMALY_FLAGS_TABLE_NAME;
const WINDOW_MINUTES = 5;
// A client is flagged if, within the window, it made at least this many
// requests, or at least this fraction of its requests were rate-limited.
const REQUEST_COUNT_THRESHOLD = 50;
const RATE_LIMIT_RATIO_THRESHOLD = 0.5;
const logsClient = new CloudWatchLogsClient({});
const dynamoClient = DynamoDBDocumentClient.from(new DynamoDBClient({}));
export const handler = async () => {
    const nowMs = Date.now();
    const windowStartMs = nowMs - WINDOW_MINUTES * 60 * 1000;
    const stats = await queryRecentTraffic(windowStartMs, nowMs);
    const flagged = stats.filter(isAnomalous);
    for (const client of flagged) {
        await recordFlag(client, windowStartMs, nowMs);
    }
    console.log(`anomaly-detector: scanned ${stats.length} clients, flagged ${flagged.length}`);
};
async function queryRecentTraffic(startMs, endMs) {
    const query = `
    fields identity, rateLimited
    | filter @message like /request completed/
  `;
    const startResponse = await logsClient.send(new StartQueryCommand({
        logGroupName: LOG_GROUP_NAME,
        startTime: Math.floor(startMs / 1000),
        endTime: Math.floor(endMs / 1000),
        queryString: query,
        limit: 10000,
    }));
    const queryId = startResponse.queryId;
    const rows = await pollQueryResults(queryId);
    const byIdentity = new Map();
    for (const row of rows) {
        const identity = row.find((f) => f.field === "identity")?.value;
        const rateLimited = row.find((f) => f.field === "rateLimited")?.value;
        if (!identity)
            continue;
        const entry = byIdentity.get(identity) ?? {
            identity,
            totalRequests: 0,
            rateLimitedRequests: 0,
        };
        entry.totalRequests += 1;
        if (rateLimited === "true")
            entry.rateLimitedRequests += 1;
        byIdentity.set(identity, entry);
    }
    return Array.from(byIdentity.values());
}
async function pollQueryResults(queryId) {
    // Logs Insights queries are async — poll until the query finishes.
    for (let attempt = 0; attempt < 10; attempt++) {
        const result = await logsClient.send(new GetQueryResultsCommand({ queryId }));
        if (result.status === "Complete") {
            return (result.results ?? []).map((row) => row.map((f) => ({ field: f.field, value: f.value })));
        }
        if (result.status === "Failed" || result.status === "Cancelled") {
            throw new Error(`Logs Insights query ${result.status}`);
        }
        await new Promise((resolve) => setTimeout(resolve, 1000));
    }
    throw new Error("Logs Insights query did not complete in time");
}
function isAnomalous(stats) {
    if (stats.totalRequests >= REQUEST_COUNT_THRESHOLD)
        return true;
    const ratio = stats.rateLimitedRequests / stats.totalRequests;
    return ratio >= RATE_LIMIT_RATIO_THRESHOLD;
}
async function recordFlag(client, windowStartMs, detectedAtMs) {
    const reason = client.totalRequests >= REQUEST_COUNT_THRESHOLD
        ? "high_request_volume"
        : "high_rate_limit_ratio";
    await dynamoClient.send(new PutCommand({
        TableName: ANOMALY_TABLE_NAME,
        Item: {
            identity: client.identity,
            reason,
            totalRequests: client.totalRequests,
            rateLimitedRequests: client.rateLimitedRequests,
            windowStart: new Date(windowStartMs).toISOString(),
            detectedAt: new Date(detectedAtMs).toISOString(),
        },
    }));
}
