import awsLambdaFastify from '@fastify/aws-lambda';
import {buildApp} from './app.js';

const app = buildApp(); // Assuming buildApp is a function that initializes your Fastify 

export const handler = awsLambdaFastify(app);