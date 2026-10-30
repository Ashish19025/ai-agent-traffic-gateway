import { CloudWatchLogsClient, StartQueryCommand, GetQueryResultsCommand, } from "@aws-sdk/client-cloudwatch-logs";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, ScanCommand } from "@aws-sdk/lib-dynamodb";
const LOG_GROUP_NAME = process.env.GATEWAY_LOG_GROUP_NAME;
const ANOMALY_TABLE_NAME = process.env.ANOMALY_FLAGS_TABLE_NAME;
const REPORT_WINDOW_MINUTES = 60;
const logsClient = new CloudWatchLogsClient({});
const dynamoClient = DynamoDBDocumentClient.from(new DynamoDBClient({}));
export async function buildReport() {
    const nowMs = Date.now();
    const startMs = nowMs - REPORT_WINDOW_MINUTES * 60 * 1000;
    const [trafficSummary, anomalies] = await Promise.all([
        queryTrafficSummary(startMs, nowMs),
        scanAnomalyFlags(),
    ]);
    return {
        windowMinutes: REPORT_WINDOW_MINUTES,
        trafficSummary,
        anomalies,
    };
}
async function queryTrafficSummary(startMs, endMs) {
    const query = `
    fields callerType, rateLimited
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
    const summary = {
        totalRequests: 0,
        byCallerType: {},
        rateLimitedRequests: 0,
    };
    for (const row of rows) {
        const callerType = row.find((f) => f.field === "callerType")?.value ?? "unknown";
        const rateLimited = row.find((f) => f.field === "rateLimited")?.value;
        summary.totalRequests += 1;
        summary.byCallerType[callerType] = (summary.byCallerType[callerType] ?? 0) + 1;
        if (rateLimited === "true")
            summary.rateLimitedRequests += 1;
    }
    return summary;
}
async function pollQueryResults(queryId) {
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
async function scanAnomalyFlags() {
    const result = await dynamoClient.send(new ScanCommand({ TableName: ANOMALY_TABLE_NAME }));
    return (result.Items ?? []);
}
