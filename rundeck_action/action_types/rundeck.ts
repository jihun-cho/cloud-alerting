/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License;
 * you may not use this file except in compliance with the Elastic License.
 */
import axios, { AxiosError, AxiosResponse } from 'axios';
import { schema, TypeOf } from '@kbn/config-schema';
import { nullableType } from '../../../x-pack/legacy/plugins/actions/server/builtin_action_types/lib/nullable';
import { ActionType, ActionTypeExecutorOptions, ActionTypeExecutorResult } from '../../../x-pack/legacy/plugins/actions/server/types';
import { IncomingWebhook } from '@slack/webhook';
import { Logger } from '../logger'

const headersSchema = schema.recordOf(schema.string(), schema.string());

const configSchemaProps = {
  rundeckBaseUrl: schema.uri(),
  rundeckApiVersion: schema.oneOf([schema.number()], { defaultValue: 24}),
  rundeckJobId: schema.string(),
  headers: nullableType(headersSchema),
};

type ActionTypeConfigType = TypeOf<typeof ConfigSchema>;
const ConfigSchema = schema.object(configSchemaProps);

type ActionTypeSecretsType = TypeOf<typeof SecretsSchema>;
const SecretsSchema = schema.object({
  rundeckApiToken: schema.string(),
  pdApiKey: nullableType(schema.string()),
  slackWebhookUrl: nullableType(schema.string()),
});

/*
 * dedupKey   : Pager Duty incident deduplicate key
 * alertName  : alert name or description to be used when sending a message to Slack channel
 * jobParams  : parameters used by rundeck job
 * options    : options if needed
 */
type ActionParamsType = TypeOf<typeof ParamsSchema>;
const ParamsSchema = schema.object({
  dedupKey: nullableType(schema.string()),
  alertName: nullableType(schema.string()),
  jobParams: schema.maybe(schema.object({
    options: schema.maybe(schema.any())
  })),
});

export function getActionType(logger: Logger): ActionType {
  return {
    id: '.rundeck',
    name: 'rundeck',
    validate: {
      config: schema.object(configSchemaProps),
      secrets: SecretsSchema,
      params: ParamsSchema,
    },
    executor: (options) => executor(logger, options),
  };
}

export async function executor(
  logger: Logger,
  execOptions: ActionTypeExecutorOptions
): Promise<ActionTypeExecutorResult> {

  const actionId = execOptions.actionId;

  const { 
    rundeckBaseUrl, 
    rundeckApiVersion, 
    rundeckJobId, 
    headers = {} 
  } = execOptions.config as ActionTypeConfigType;
  
  const { 
    rundeckApiToken, 
    pdApiKey, 
    slackWebhookUrl 
  } = execOptions.secrets as ActionTypeSecretsType;

  const { 
    dedupKey, 
    alertName, 
    jobParams 
  } = execOptions.params as ActionParamsType;

  // call Rundeck job execution API
  let rundeckResult: any;
  try {
    const rundeckApiOptions = {
      actionId,
      headers,
      rundeckBaseUrl,
      rundeckApiToken,
      rundeckApiVersion, 
      rundeckJobId, 
      jobParams, 
      logger,
    }

    rundeckResult = await executeRundeckJob(rundeckApiOptions);

  } catch (err) { // when response code >= 300, by axios

    // try to use response message first then using axios stack message
    const message = err.response ? err.response.data.message : err.message;
    logger.warn(`Error on ${actionId} rundeck action: ${message}`);
    return errorResult(actionId, message);
  }
  
  // retrieve the rundeck job link
  const executionLink = rundeckResult.data.permalink;

  // send slack message when "dedupKey" is not set
  if(!dedupKey) {

    if(!slackWebhookUrl) {
      const message = "Neither of dedupKey nor slackWebhookUrl are provided, failed to send message to PagerDuty incident or slack channel.";
      return errorSlackProcess(actionId, message);
    }

    try {
      const webhook = new IncomingWebhook(slackWebhookUrl);

      const message = {
        "text": alertName,
        "attachments": [
          {
            "text": `Rundeck job for the alert is triggered. Link: ${executionLink}`
          }
        ]
      }
      await webhook.send(message)

      // nothing to do more but just logging
      logger.info(`Sending message to Slack succeeded in rundeck action "${actionId}".`);

    } catch (err) {

      const message = `an error occurred while calling slack webhook: ${err.error}`
      logger.warn(`Error on ${actionId} rundeck action: ${message}`);
      return errorSlackProcess(actionId, message);
    }

    // return with rundeck result.
    return successResult(rundeckResult.data);
  }

  // call Pager Duty incident list API to retrieve incident id
  // it is needed to call add note API
  let pdIncidentListResult: any;
  try {
    const pagerDutyApiOptions = {
      headers,
      pdApiKey,
      dedupKey,
    }

    pdIncidentListResult = await getPagerDutyIncidentList(pagerDutyApiOptions);

    logger.info(`Retrieving Pager Duty incident list succeeded in rundeck action "${actionId}".`);

  } catch (err) {
    
    const message = err.response ? `${err.response.status} ${err.response.data.error.message}` : err.message; 
    logger.warn(`error on ${actionId} rundeck action: an error occurred while calling pager duty API: ${message}`);
    return errorPagerDutyProcess(actionId, message);
  }

  // incident list is empty
  if (!pdIncidentListResult.data.incidents.length) {
    const message: string = `Pager Duty incident list requested by dedupKey(incident_key), "${dedupKey}", is empty.`
    logger.warn(`error on ${actionId} rundeck action: ${message}`);
    return errorPagerDutyProcess(actionId, message);
  }

  // get incident id
  const incidentId = pdIncidentListResult.data.incidents.pop().id

  // call Pager Duty add note API
  try {
    const pagerDutyApiOptions = {
      headers,
      pdApiKey,
      incidentId,
      executionLink,
    };

    await addNoteToPagerDutyIncident(pagerDutyApiOptions);

    logger.info(`Calling pagerduty "create a note API" step succeeded in rundeck action "${actionId}"`);

  } catch (err) {

    const message = err.response ? `${err.response.status} ${err.response.data.error.message}` : err.message;
    logger.warn(`error on ${actionId} rundeck action: an error occurred while calling pager duty API: ${message}`);
    return errorPagerDutyProcess(actionId, err.message);
  }

  logger.info(`response from rundeck action "${actionId}": [HTTP ${rundeckResult.status}] ${rundeckResult.statusText}`);    
  
  return successResult(rundeckResult.data);
  
}

async function executeRundeckJob({
  headers, 
  rundeckBaseUrl,
  rundeckApiToken, 
  rundeckApiVersion, 
  rundeckJobId, 
  jobParams,
}): Promise<AxiosResponse|AxiosError> {

  // add rundeck api token to headers
  headers = Object.assign({}, headers, {"X-Rundeck-Auth-Token": rundeckApiToken});

  // trim last '/' in the rundeckBaseUrl
  const rundeckBaseUrlWithoutSlash = rundeckBaseUrl.endsWith('/') ? rundeckBaseUrl.slice(0, -1) : rundeckBaseUrl;

  const rundeckApiUrl = `${rundeckBaseUrlWithoutSlash}/api/${rundeckApiVersion}/job/${rundeckJobId}/executions`;

  return await axios.post(rundeckApiUrl, jobParams, { headers });
}

async function getPagerDutyIncidentList({headers, pdApiKey, dedupKey}): Promise<AxiosResponse|AxiosError> {

  headers = Object.assign({}, headers, {authorization: `Token token=${pdApiKey}`});

  const pdIncidentListApiUrl = `https://api.pagerduty.com/incidents?date_range=all&incident_key=${dedupKey}`;

  return await axios.get(pdIncidentListApiUrl, { headers });
}

async function addNoteToPagerDutyIncident({ headers, 
  pdApiKey, 
  incidentId,
  executionLink,
}): Promise<AxiosResponse|AxiosError> {

  headers = Object.assign({}, headers, {authorization: `Token token=${pdApiKey}`});

  const pdAddNoteApiUrl = `https://api.pagerduty.com/incidents/${incidentId}/notes`;

  const noteMessage = {
    note: {
      content: `Rundeck job for the alert is triggered. Link: ${executionLink}`
    }
  };

  return axios.post(pdAddNoteApiUrl, noteMessage, { headers });
}

function successResult(data: any): ActionTypeExecutorResult {
  return { status: 'ok', data };
}

function errorPagerDutyProcess(id: string, message: string): ActionTypeExecutorResult {
  const errMessage = `An error occurred while calling Pager Duty API in rundeck action "${id}": ${message}`;
  return {
    status: 'error',
    message: errMessage,
  };
}

function errorSlackProcess(id: string, message: string): ActionTypeExecutorResult {
  const errMessage = `Invalid Response: an error occurred in rundeck action "${id}": ${message}`;
  return {
    status: 'error',
    message: errMessage,
  };
}

function errorResult(id: string, message: string): ActionTypeExecutorResult {
  const errMessage = `Invalid Response: an error occurred in rundeck action "${id}" calling a rundeck job: ${message}`;
  return {
    status: 'error',
    message: errMessage,
  };
}

