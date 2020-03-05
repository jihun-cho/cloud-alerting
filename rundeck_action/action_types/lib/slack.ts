import { IncomingWebhook, IncomingWebhookResult } from '@slack/webhook';
import { Logger } from '../../logger'

export interface SlackApiOptions {
  actionId: string;
  slackWebhookUrl: string;
  message: string;
  logger: Logger;
}

export interface SlackApiResult {
  status: 'ok' | 'error';
  message?: string;
  data?: any;
  retry?: null | boolean | Date;
}

export async function callSlackApi(options: SlackApiOptions): Promise<SlackApiResult> {
  const { actionId, slackWebhookUrl, message, logger } = options;

  let result: IncomingWebhookResult;

  try {

    const webhook = new IncomingWebhook(slackWebhookUrl);
    result = await webhook.send(message);

  } catch (err) {
    if (err.original == null || err.original.response == null) {
      return errorResult(actionId, err.message);
    }

    const { status, statusText } = err.original.response;

    // special handling for rate limiting(429) and special handling for 5xx
    if (status === 429 || status >= 500) {
      return retryResult(actionId, err.message);
    }

    return errorResult(actionId, `${err.message} - ${statusText}`);
  }

  return successResult(result);
} 

function successResult(data: any): SlackApiResult {
  return { status: 'ok', data };
}

function errorResult(actionId: string, message: string): SlackApiResult {
  const errMessage = `an error occurred posting a slack message: ${message}`;
  return {
    status: 'error',
    message: errMessage,
  };
}

function retryResult(actionId: string, message: string): SlackApiResult {
  const errMessage = `an error occurred posting a slack message, retry later: ${message}`
  return {
    status: 'error',
    message: errMessage,
    retry: true,
  };
}