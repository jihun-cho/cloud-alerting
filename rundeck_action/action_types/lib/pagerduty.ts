import axios, { AxiosError, AxiosResponse } from 'axios';
import { isOk, promiseResult } from '../../../../x-pack/legacy/plugins/actions/server/builtin_action_types/lib/result_type';
import { Logger } from '../../logger'

export interface PagerDutyApiOptions {
  actionId: string;
  url: string;
  method: string;
  headers: any;
  dedupKey: string;
  data: object;
  logger: Logger;
}

export interface PagerDutyApiResult {
  status: 'ok' | 'error';
  message?: string;
  data?: any;
  retry?: null | boolean | Date;
}

export async function callPagerDutyApi(options: PagerDutyApiOptions): Promise<PagerDutyApiResult> {
  const { actionId, url, method, headers, data, logger } = options;

  const response = await promiseResult(
    axios.request({
      method,
      url,
      headers,
      data,
    })
  );

  if(isOk(response)) {
    logger.debug(`response status of calling pagerduty api in rundeck action "${actionId}": ${response.value.status}`);

    return {
      status: 'ok',
      data: response.value.data,
    };
  } else {
    const { status } = (response.error as AxiosError).response;

    if (status === 429 || status >= 500) {

      logger.warn(`response status of calling pagerduty api in rundeck action "${actionId}": ${status}`);
      const message = `error in calling pagerduty api step: status ${status}, retry later`
  
      return {
        status: 'error',
        message,
        retry: true,
      };
    }

    logger.warn(`response status of calling pagerduty api in rundeck action "${actionId}": ${status}`);
    const message = `error in calling pagerduty api step "${actionId}": unexpected status ${status}`

    return {
      status: 'error',
      message,
    };
  }
}