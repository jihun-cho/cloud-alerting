import { Logger } from './logger'
import { getActionType as getRundeckActionType } from './action_types/rundeck'
import { ActionType } from '../../x-pack/legacy/plugins/actions/server/types';

const PLUGIN_NAME = rundeckAction.name

export default function rundeckAction(kibana: any) {
  return new kibana.Plugin({
    id: PLUGIN_NAME,
    require: ['kibana', 'actions'],
    init,
  })
}

export let serverLog: Logger

function init(server: any) {
  serverLog = new Logger(server, PLUGIN_NAME)
  registerActionType(server, getRundeckActionType(serverLog))
}

function registerActionType(server: any, actionType: ActionType) {
  server.plugins.actions.setup.registerType(actionType)
  serverLog.info(`registered action type: ${actionType.id}`)
}
