import sourceData from '../data/superdock-error-codes.json'

export interface SuperDockTaskError {
  code: string
  name: string
  description: string
}

export interface SuperDockHmsError {
  code: string
  name: string
  message: string
  english: string
}

export interface SuperDockErrorCodeData {
  schemaVersion: number
  source: {
    name: string
    extractedOn: string
    taskErrorsUrl: string
    hmsUrl: string
    waylineInterruptsUrl: string
    attribution: string
  }
  taskErrors: SuperDockTaskError[]
  hmsErrors: SuperDockHmsError[]
  waylineInterrupts: SuperDockTaskError[]
}

export const superDockErrorCodeData = sourceData as SuperDockErrorCodeData
export const superDockTaskErrors = superDockErrorCodeData.taskErrors
export const superDockHmsErrors = superDockErrorCodeData.hmsErrors
export const superDockWaylineInterrupts = superDockErrorCodeData.waylineInterrupts

export const superDockErrorCodeStats = {
  task: superDockTaskErrors.length,
  hms: superDockHmsErrors.length,
  wayline: superDockWaylineInterrupts.length,
  total: superDockTaskErrors.length + superDockHmsErrors.length + superDockWaylineInterrupts.length,
} as const
