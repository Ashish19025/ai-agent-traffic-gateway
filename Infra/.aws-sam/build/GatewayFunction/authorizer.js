import { CognitoJwtVerifier } from "aws-jwt-verify";
const verifier = CognitoJwtVerifier.create({
    userPoolId: process.env.USER_POOL_ID,
    tokenUse: "access",
    clientId: process.env.MACHINE_CLIENT_ID,
    scope: "gateway/invoke",
});
export const handler = async (event) => {
    try {
        const payload = await verifier.verify(event.authorizationToken);
        return {
            principalId: payload.sub,
            policyDocument: buildPolicy("Allow", event.methodArn),
            context: {
                clientId: payload.client_id,
                scope: payload.scope,
            },
        };
    }
    catch {
        return {
            principalId: "unauthorized",
            policyDocument: buildPolicy("Deny", event.methodArn),
        };
    }
};
function buildPolicy(effect, resource) {
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
