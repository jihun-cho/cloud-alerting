/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License;
 * you may not use this file except in compliance with the Elastic License.
 */
import { curry } from 'lodash';
import axios, { AxiosError, AxiosResponse } from 'axios';
import { schema, TypeOf } from '@kbn/config-schema';
import { nullableType } from '../../../x-pack/legacy/plugins/actions/server/builtin_action_types/lib/nullable';
import { isOk, promiseResult, Result } from '../../../x-pack/legacy/plugins/actions/server/builtin_action_types/lib/result_type';
import { ActionType, ActionTypeExecutorOptions, ActionTypeExecutorResult } from '../../../x-pack/legacy/plugins/actions/server/types';
import { callPagerDutyApi, PagerDutyApiOptions, PagerDutyApiResult } from './lib/pagerduty'
import { callSlackApi, SlackApiOptions, SlackApiResult } from './lib/slack'
import { Logger } from '../logger'


// config definition
enum WebhookMethods {
  POST = 'post',
  PUT = 'put',
}

// Schema
const headersSchema = schema.recordOf(schema.string(), schema.string());

const configSchemaProps = {
  rundeckBaseUrl: schema.uri(),
  method: schema.oneOf([schema.literal(WebhookMethods.POST), schema.literal(WebhookMethods.PUT)], {
    defaultValue: WebhookMethods.POST,
  }),
  rundeckApiVersion: schema.oneOf([schema.number()], { defaultValue: 24}),
  jobId: schema.string(),
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

type ActionParamsType = TypeOf<typeof ParamsSchema>;
const ParamsSchema = schema.object({
  dedupKey: nullableType(schema.string()),
  jobParams: schema.maybe(schema.object({
    options: schema.maybe(schema.any())
  })),
});

// action type definition
export function getActionType({ logger }: { logger: Logger }): ActionType {
  return {
    id: '.rundeck',
    name: 'rundeck',
    validate: {
      config: schema.object(configSchemaProps),
      secrets: SecretsSchema,
      params: ParamsSchema,
    },
    executor: curry(executor)({ logger }),
  };
}

// action executor
// * Need API Key for calling PD Rest APIs
export async function executor(
  { logger }: { logger: Logger },
  execOptions: ActionTypeExecutorOptions
): Promise<ActionTypeExecutorResult> {
  const actionId = execOptions.actionId;
  const { method, rundeckBaseUrl, rundeckApiVersion, jobId, headers = {} } = execOptions.config as ActionTypeConfigType;
  const { rundeckApiToken } = execOptions.secrets as ActionTypeSecretsType;
  const { dedupKey, jobParams } = execOptions.params as ActionParamsType;

  Object.assign(headers, {"X-Rundeck-Auth-Token": rundeckApiToken})

  const rundeckBaseUrlWithoutSlash = rundeckBaseUrl.endsWith('/') ? rundeckBaseUrl.slice(0, -1) : rundeckBaseUrl;

  const rundeckApiUrl = `${rundeckBaseUrlWithoutSlash}/api/${rundeckApiVersion}/job/${jobId}/executions`;

  const rundeckResult: Result<AxiosResponse, AxiosError> = await promiseResult(
    axios.request({
      method,
      url: rundeckApiUrl,
      headers,
      data: jobParams
    })
  ); 

  if (isOk(rundeckResult)) {
    const {
      value: { status, statusText, data: { permalink: executionLink }},
    } = rundeckResult;

    let {
      value: {data: responseData}
    } = rundeckResult

    // pageduty APIs
    const pdIncidentListApiBaseUrl = 'https://api.pagerduty.com/incidents?incident_key=';
    const pdAddNoteApiBaseUrl = 'https://api.pagerduty.com/incidents/';

    if (dedupKey) {

      const { headers = {} } = execOptions.config as ActionTypeConfigType;
      const { pdApiKey } = execOptions.secrets as ActionTypeSecretsType;

      Object.assign(headers, {"authorization": `Token token=${pdApiKey}`})

      const pdIncidentListApiOptions: PagerDutyApiOptions = {
        actionId,
        url: `${pdIncidentListApiBaseUrl}${dedupKey}`,
        method: "get",
        headers,
        dedupKey,
        data: {},
        logger,
      }

      const pdIncidentListResult: PagerDutyApiResult = await callPagerDutyApi(pdIncidentListApiOptions);

      if (pdIncidentListResult.status === "error") {
        logger.warn(`error on ${actionId} rundeck action: ${pdIncidentListResult.message}`);
        return errorPagerDutyProcess(actionId, pdIncidentListResult.message);
      }

      // incident list is empty
      if (pdIncidentListResult.data.incidents.length == 0) {
        const message: string = `Pager Duty incident list requested by dedupKey(incident_key), "${dedupKey}", is empty.`
        return errorPagerDutyProcess(actionId, message);
      }

      // call PD create note api
      const { id: incidentId } = pdIncidentListResult.data.incidents.slice(-1)[0]

      const noteMessage = {
        note: {
          content: `Rundeck job for the alert is triggered. Link: ${executionLink}`
        }
      };

      const pdAddNoteApiOptions: PagerDutyApiOptions = {
        actionId,
        url: `${pdAddNoteApiBaseUrl}${incidentId}/notes`,
        method: "post",
        headers,
        dedupKey,
        data: noteMessage,
        logger,
      }

      const pdCreateNoteResult: PagerDutyApiResult = await callPagerDutyApi(pdAddNoteApiOptions);

      if (pdCreateNoteResult.status === "error") {
        logger.warn(`error on ${actionId} rundeck action: ${pdCreateNoteResult.message}`);
        return errorPagerDutyProcess(actionId, pdCreateNoteResult.message);
      }

      logger.info(`Calling pagerduty "create a note API" step succeeded in rundeck action "${actionId}"`);

    } else {
      const actionId = execOptions.actionId;
      const { slackWebhookUrl } = execOptions.secrets as ActionTypeSecretsType;
      const message = `Rundeck job for the alert is triggered. Link: ${executionLink}`

      const slackApiOptions: SlackApiOptions = {
        actionId,
        slackWebhookUrl,
        message,
        logger,
      }

      const slackMessageResult: SlackApiResult = await callSlackApi(slackApiOptions);

      if (slackMessageResult.status === "error") {
        return errorSlackProcess(actionId, slackMessageResult.message);
      }

      logger.info(`Sending message to slack step succeeded in rundeck action "${actionId}"`);
    }

    logger.info(`response from rundeck action "${actionId}": [HTTP ${status}] ${statusText}`);    
    
    return successResult(responseData);
  } else {
    const { error } = rundeckResult;

    if (error.response) {
      const { status, statusText, headers: responseHeaders } = error.response;
      const message = `[${status}] ${statusText}`;

      logger.warn(`error on ${actionId} rundeck event: ${message}`);

      // The request was made and the server responded with a status code
      // that falls out of the range of 2xx
      // special handling for 5xx
      if (status >= 500) {
        return retryResult(actionId, message);
      }

      return errorResultInvalid(actionId, message);
    }

    const message = 'Unreachable rundeck host, are you sure the address is correct?'
    
    logger.warn(`error on ${actionId} rundeck action: ${message}`);

    return errorResultUnreachable(actionId, message);
  }
}

function successResult(data: any): ActionTypeExecutorResult {
  return { status: 'ok', data };
}

function errorPagerDutyProcess(id: string, message: string): ActionTypeExecutorResult {
  const errMessage = `Invalid Response: an error occurred in rundeck action "${id}": ${message}`;
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

function errorResultInvalid(id: string, message: string): ActionTypeExecutorResult {
  const errMessage = `Invalid Response: an error occurred in rundeck action "${id}" calling a rundeck job: ${message}`;
  return {
    status: 'error',
    message: errMessage,
  };
}

function errorResultUnreachable(id: string, message: string): ActionTypeExecutorResult {
  const errMessage = `Unreachable Webhook: an error occurred in rundeck action "${id}" calling a rundeck job: ${message}`;
  return {
    status: 'error',
    message: errMessage,
  };
}

function retryResult(id: string, message: string): ActionTypeExecutorResult {
  const errMessage = `Invalid Response: an error occurred in rundeck action "${id}" calling a rundeck job, retry later`
  return {
    status: 'error',
    message: errMessage,
    retry: true,
  };
}
