import { CognitoJwtVerifier } from "aws-jwt-verify";
import type {
  APIGatewayTokenAuthorizerEvent,
  APIGatewayAuthorizerResult,
} from "aws-lambda";

const machineVerifier = CognitoJwtVerifier.create({
  userPoolId: process.env.USER_POOL_ID!,
  tokenUse: "access",
  clientId: process.env.MACHINE_CLIENT_ID!,
  scope: "gateway/invoke",
});

const humanVerifier = CognitoJwtVerifier.create({
  userPoolId: process.env.USER_POOL_ID!,
  tokenUse: "id",
  clientId: process.env.HUMAN_CLIENT_ID!,
});

export const handler = async (
  event: APIGatewayTokenAuthorizerEvent
): Promise<APIGatewayAuthorizerResult> => {
  // this is the payload for machine users
  try {
    const payload = await machineVerifier.verify(event.authorizationToken);

    return {
      principalId: payload.sub,
      policyDocument: buildPolicy("Allow", wildcardResource(event.methodArn)),
      context: {
        clientId: payload.client_id as string,
        scope: payload.scope as string,
        callerType: "agent",
      },
    };
  } catch {
    // not a valid machine token, try to verify as a human token 
  }
  

  // this is the payload for human users 
  try{
    const payload = await humanVerifier.verify(event.authorizationToken);

    return {
      principalId: payload.sub,
      policyDocument: buildPolicy("Allow", wildcardResource(event.methodArn)),
      context: {
        email: payload.email as string,
        callerType: "human",
      },
    };
  }catch{
    return {
      principalId: "unauthorized",
      policyDocument: buildPolicy("Deny", event.methodArn),
    };
  }
};

function wildcardResource(methodArn: string): string {
  const arnPrefix = methodArn.split("/")[0];
  return `${arnPrefix}/*`;
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
