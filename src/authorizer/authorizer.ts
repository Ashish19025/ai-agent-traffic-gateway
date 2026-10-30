import { CognitoJwtVerifier } from "aws-jwt-verify";
import type {
  APIGatewayTokenAuthorizerEvent,
  APIGatewayAuthorizerResult,
} from "aws-lambda";

const verifier = CognitoJwtVerifier.create({
  userPoolId: process.env.USER_POOL_ID!,
  tokenUse: "access",
  clientId: process.env.MACHINE_CLIENT_ID!,
  scope: "gateway/invoke",
});

export const handler = async (
  event: APIGatewayTokenAuthorizerEvent
): Promise<APIGatewayAuthorizerResult> => {
  try {
    const payload = await verifier.verify(event.authorizationToken);

    return {
      principalId: payload.sub,
      policyDocument: buildPolicy("Allow", wildcardResource(event.methodArn)),
      context: {
        clientId: payload.client_id as string,
        scope: payload.scope as string,
      },
    };
  } catch {
    return {
      principalId: "unauthorized",
      policyDocument: buildPolicy("Deny", event.methodArn),
    };
  }
};

function wildcardResource(methodArn: string): string {
  const [arnPrefix] = methodArn.split("/", 2);
  return `${arnPrefix}/*/*`;
}

function buildPolicy(
  effect: "Allow" | "Deny",
  resource: string
): APIGatewayAuthorizerResult["policyDocument"] {
  return {
    Version: "2012-10-17",
    Statement: [
      {
        Action: "execute-api:Invoke",
        Effect: effect,
        Resource: resource,
      },
    ],
  };
}
