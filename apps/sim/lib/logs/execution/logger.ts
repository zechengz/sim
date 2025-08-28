import { eq, sql } from 'drizzle-orm'
import { v4 as uuidv4 } from 'uuid'
import { getCostMultiplier, isBillingEnabled } from '@/lib/environment'
import { createLogger } from '@/lib/logs/console/logger'
import { snapshotService } from '@/lib/logs/execution/snapshot/service'
import { get_logger } from 'traceroot-sdk-ts'
import * as traceroot from 'traceroot-sdk-ts'
import type {
  BlockOutputData,
  ExecutionEnvironment,
  ExecutionTrigger,
  ExecutionLoggerService as IExecutionLoggerService,
  TraceSpan,
  WorkflowExecutionLog,
  WorkflowExecutionSnapshot,
  WorkflowState,
} from '@/lib/logs/types'
import { db } from '@/db'
import { userStats, workflow, workflowExecutionLogs } from '@/db/schema'

export interface ToolCall {
  name: string
  duration: number // in milliseconds
  startTime: string // ISO timestamp
  endTime: string // ISO timestamp
  status: 'success' | 'error'
  input?: Record<string, any>
  output?: Record<string, any>
  error?: string
}

const logger = createLogger('ExecutionLogger')
const traceLogger = get_logger('ExecutionLogger')

export class ExecutionLogger implements IExecutionLoggerService {
  async startWorkflowExecution(params: {
    workflowId: string
    executionId: string
    trigger: ExecutionTrigger
    environment: ExecutionEnvironment
    workflowState: WorkflowState
  }): Promise<{
    workflowLog: WorkflowExecutionLog
    snapshot: WorkflowExecutionSnapshot
  }> {
    const { workflowId, executionId, trigger, environment, workflowState } = params

    const startWorkflowExecutionTrace = traceroot.traceFunction(
      async function startWorkflowExecutionTrace() {
        logger.debug(`Starting workflow execution ${executionId} for workflow ${workflowId}`)
        traceLogger.debug({ workflowId, executionId }, `Starting workflow execution ${executionId} for workflow ${workflowId}`)

        const snapshotResult = await snapshotService.createSnapshotWithDeduplication(
          workflowId,
          workflowState
        )

        const startTime = new Date()

        const [workflowLog] = await db
          .insert(workflowExecutionLogs)
          .values({
            id: uuidv4(),
            workflowId,
            executionId,
            stateSnapshotId: snapshotResult.snapshot.id,
            level: 'info',
            trigger: trigger.type,
            startedAt: startTime,
            endedAt: null,
            totalDurationMs: null,
            executionData: {
              environment,
              trigger,
            },
          })
          .returning()

        logger.debug(`Created workflow log ${workflowLog.id} for execution ${executionId}`)
        traceLogger.debug({ workflowId, executionId }, `Created workflow log ${workflowLog.id} for execution ${executionId}`)

        return {
          workflowLog: {
            id: workflowLog.id,
            workflowId: workflowLog.workflowId,
            executionId: workflowLog.executionId,
            stateSnapshotId: workflowLog.stateSnapshotId,
            level: workflowLog.level as 'info' | 'error',
            trigger: workflowLog.trigger as ExecutionTrigger['type'],
            startedAt: workflowLog.startedAt.toISOString(),
            endedAt: workflowLog.endedAt?.toISOString() || workflowLog.startedAt.toISOString(),
            totalDurationMs: workflowLog.totalDurationMs || 0,
            executionData: workflowLog.executionData as WorkflowExecutionLog['executionData'],
            createdAt: workflowLog.createdAt.toISOString(),
          },
          snapshot: snapshotResult.snapshot,
        }
      },
      { spanName: 'startWorkflowExecution', traceParams: true }
    )

    return await startWorkflowExecutionTrace()
  }

  async completeWorkflowExecution(params: {
    executionId: string
    endedAt: string
    totalDurationMs: number
    costSummary: {
      totalCost: number
      totalInputCost: number
      totalOutputCost: number
      totalTokens: number
      totalPromptTokens: number
      totalCompletionTokens: number
      baseExecutionCharge: number
      modelCost: number
      models: Record<
        string,
        {
          input: number
          output: number
          total: number
          tokens: { prompt: number; completion: number; total: number }
        }
      >
    }
    finalOutput: BlockOutputData
    traceSpans?: TraceSpan[]
  }): Promise<WorkflowExecutionLog> {
    const { executionId, endedAt, totalDurationMs, costSummary, finalOutput, traceSpans } = params

    const completeWorkflowExecutionTrace = traceroot.traceFunction(
      async () => {
        logger.debug(`Completing workflow execution ${executionId}`)
        traceLogger.debug({ executionId }, `Completing workflow execution ${executionId}`)

        // Determine if workflow failed by checking trace spans for errors
        const hasErrors = traceSpans?.some((span: any) => {
          const checkSpanForErrors = (s: any): boolean => {
            if (s.status === 'error') return true
            if (s.children && Array.isArray(s.children)) {
              return s.children.some(checkSpanForErrors)
            }
            return false
          }
          return checkSpanForErrors(span)
        })

        const level = hasErrors ? 'error' : 'info'

        // Extract files from trace spans and final output
        const executionFiles = this.extractFilesFromExecution(traceSpans, finalOutput)

        const [updatedLog] = await db
          .update(workflowExecutionLogs)
          .set({
            level,
            endedAt: new Date(endedAt),
            totalDurationMs,
            files: executionFiles.length > 0 ? executionFiles : null,
            executionData: {
              traceSpans,
              finalOutput,
              tokenBreakdown: {
                prompt: costSummary.totalPromptTokens,
                completion: costSummary.totalCompletionTokens,
                total: costSummary.totalTokens,
              },
              models: costSummary.models,
            },
            cost: {
              total: costSummary.totalCost,
              input: costSummary.totalInputCost,
              output: costSummary.totalOutputCost,
              tokens: {
                prompt: costSummary.totalPromptTokens,
                completion: costSummary.totalCompletionTokens,
                total: costSummary.totalTokens,
              },
              models: costSummary.models,
            },
          })
          .where(eq(workflowExecutionLogs.executionId, executionId))
          .returning()

        if (!updatedLog) {
          throw new Error(`Workflow log not found for execution ${executionId}`)
        }

        // Update user stats with cost information (same logic as original execution logger)
        await this.updateUserStats(
          updatedLog.workflowId,
          costSummary,
          updatedLog.trigger as ExecutionTrigger['type']
        )

        const workflowId = updatedLog.workflowId
        logger.debug(`Completed workflow execution ${executionId}`)
        traceLogger.debug({ workflowId, executionId }, `Completed workflow execution ${executionId}`)

        return {
          id: updatedLog.id,
          workflowId: updatedLog.workflowId,
          executionId: updatedLog.executionId,
          stateSnapshotId: updatedLog.stateSnapshotId,
          level: updatedLog.level as 'info' | 'error',
          trigger: updatedLog.trigger as ExecutionTrigger['type'],
          startedAt: updatedLog.startedAt.toISOString(),
          endedAt: updatedLog.endedAt?.toISOString() || endedAt,
          totalDurationMs: updatedLog.totalDurationMs || totalDurationMs,
          executionData: updatedLog.executionData as WorkflowExecutionLog['executionData'],
          cost: updatedLog.cost as any,
          createdAt: updatedLog.createdAt.toISOString(),
        }
      },
      { spanName: 'completeWorkflowExecution', traceParams: true }
    )

    return await completeWorkflowExecutionTrace()
  }

  async getWorkflowExecution(executionId: string): Promise<WorkflowExecutionLog | null> {
    const getWorkflowExecutionTrace = traceroot.traceFunction(
      async function getWorkflowExecutionTrace() {
        const [workflowLog] = await db
          .select()
          .from(workflowExecutionLogs)
          .where(eq(workflowExecutionLogs.executionId, executionId))
          .limit(1)

        if (!workflowLog) return null

        return {
          id: workflowLog.id,
          workflowId: workflowLog.workflowId,
          executionId: workflowLog.executionId,
          stateSnapshotId: workflowLog.stateSnapshotId,
          level: workflowLog.level as 'info' | 'error',
          trigger: workflowLog.trigger as ExecutionTrigger['type'],
          startedAt: workflowLog.startedAt.toISOString(),
          endedAt: workflowLog.endedAt?.toISOString() || workflowLog.startedAt.toISOString(),
          totalDurationMs: workflowLog.totalDurationMs || 0,
          executionData: workflowLog.executionData as WorkflowExecutionLog['executionData'],
          cost: workflowLog.cost as any,
          createdAt: workflowLog.createdAt.toISOString(),
        }
      },
      { spanName: 'getWorkflowExecution', traceParams: true }
    )

    return await getWorkflowExecutionTrace()
  }

  /**
   * Updates user stats with cost and token information
   * Maintains same logic as original execution logger for billing consistency
   */
  private async updateUserStats(
    workflowId: string,
    costSummary: {
      totalCost: number
      totalInputCost: number
      totalOutputCost: number
      totalTokens: number
      totalPromptTokens: number
      totalCompletionTokens: number
      baseExecutionCharge: number
      modelCost: number
    },
    trigger: ExecutionTrigger['type']
  ): Promise<void> {
    if (!isBillingEnabled) {
      logger.debug('Billing is disabled, skipping user stats cost update')
      traceLogger.debug({ workflowId }, 'Billing is disabled, skipping user stats cost update')
      return
    }

    if (costSummary.totalCost <= 0) {
      logger.debug('No cost to update in user stats')
      traceLogger.debug({ workflowId }, 'No cost to update in user stats')
      return
    }

    try {
      // Get the workflow record to get the userId
      const [workflowRecord] = await db
        .select()
        .from(workflow)
        .where(eq(workflow.id, workflowId))
        .limit(1)

      if (!workflowRecord) {
        logger.error(`Workflow ${workflowId} not found for user stats update`)
        return
      }

      const userId = workflowRecord.userId
      const costMultiplier = getCostMultiplier()
      // Apply cost multiplier only to model costs, not base execution charge
      const costToStore = costSummary.baseExecutionCharge + costSummary.modelCost * costMultiplier

      // Check if user stats record exists
      const userStatsRecords = await db.select().from(userStats).where(eq(userStats.userId, userId))

      if (userStatsRecords.length === 0) {
        // Create new user stats record with trigger-specific counts
        const triggerCounts = this.getTriggerCounts(trigger)

        await db.insert(userStats).values({
          id: crypto.randomUUID(),
          userId: userId,
          totalManualExecutions: triggerCounts.manual,
          totalApiCalls: triggerCounts.api,
          totalWebhookTriggers: triggerCounts.webhook,
          totalScheduledExecutions: triggerCounts.schedule,
          totalChatExecutions: triggerCounts.chat,
          totalTokensUsed: costSummary.totalTokens,
          totalCost: costToStore.toString(),
          currentPeriodCost: costToStore.toString(), // Initialize current period usage
          lastActive: new Date(),
        })

        logger.debug('Created new user stats record with cost data', {
          userId,
          trigger,
          totalCost: costToStore,
          totalTokens: costSummary.totalTokens,
        })
        traceLogger.debug({ workflowId }, 'Created new user stats record with cost data', {
          userId,
          trigger,
          totalCost: costToStore,
          totalTokens: costSummary.totalTokens,
        })
      } else {
        // Update existing user stats record with trigger-specific increments
        const updateFields: any = {
          totalTokensUsed: sql`total_tokens_used + ${costSummary.totalTokens}`,
          totalCost: sql`total_cost + ${costToStore}`,
          currentPeriodCost: sql`current_period_cost + ${costToStore}`, // Track current billing period usage
          lastActive: new Date(),
        }

        // Add trigger-specific increment
        switch (trigger) {
          case 'manual':
            updateFields.totalManualExecutions = sql`total_manual_executions + 1`
            break
          case 'api':
            updateFields.totalApiCalls = sql`total_api_calls + 1`
            break
          case 'webhook':
            updateFields.totalWebhookTriggers = sql`total_webhook_triggers + 1`
            break
          case 'schedule':
            updateFields.totalScheduledExecutions = sql`total_scheduled_executions + 1`
            break
          case 'chat':
            updateFields.totalChatExecutions = sql`total_chat_executions + 1`
            break
        }

        await db.update(userStats).set(updateFields).where(eq(userStats.userId, userId))

        logger.debug('Updated existing user stats record with cost data', {
          userId,
          trigger,
          addedCost: costToStore,
          addedTokens: costSummary.totalTokens,
        })
        traceLogger.debug({ workflowId }, 'Updated existing user stats record with cost data', {
          userId,
          trigger,
          addedCost: costToStore,
          addedTokens: costSummary.totalTokens,
        })
      }
    } catch (error) {
      logger.error('Error updating user stats with cost information', {
        workflowId,
        error,
        costSummary,
      })
      // Don't throw - we want execution to continue even if user stats update fails
    }
  }

  /**
   * Get trigger counts for new user stats records
   */
  private getTriggerCounts(trigger: ExecutionTrigger['type']): {
    manual: number
    api: number
    webhook: number
    schedule: number
    chat: number
  } {
    const counts = { manual: 0, api: 0, webhook: 0, schedule: 0, chat: 0 }
    switch (trigger) {
      case 'manual':
        counts.manual = 1
        break
      case 'api':
        counts.api = 1
        break
      case 'webhook':
        counts.webhook = 1
        break
      case 'schedule':
        counts.schedule = 1
        break
      case 'chat':
        counts.chat = 1
        break
    }
    return counts
  }

  private getTriggerPrefix(triggerType: ExecutionTrigger['type']): string {
    switch (triggerType) {
      case 'api':
        return 'API'
      case 'webhook':
        return 'Webhook'
      case 'schedule':
        return 'Scheduled'
      case 'manual':
        return 'Manual'
      case 'chat':
        return 'Chat'
      default:
        return 'Unknown'
    }
  }

  /**
   * Extract file references from execution trace spans and final output
   */
  private extractFilesFromExecution(traceSpans?: any[], finalOutput?: any): any[] {
    const files: any[] = []
    const seenFileIds = new Set<string>()

    // Helper function to extract files from any object
    const extractFilesFromObject = (obj: any, source: string) => {
      if (!obj || typeof obj !== 'object') return

      // Check if this object has files property
      if (Array.isArray(obj.files)) {
        for (const file of obj.files) {
          if (file?.name && file.key && file.id) {
            if (!seenFileIds.has(file.id)) {
              seenFileIds.add(file.id)
              files.push({
                id: file.id,
                name: file.name,
                size: file.size,
                type: file.type,
                url: file.url,
                key: file.key,
                uploadedAt: file.uploadedAt,
                expiresAt: file.expiresAt,
                storageProvider: file.storageProvider,
                bucketName: file.bucketName,
              })
            }
          }
        }
      }

      // Check if this object has attachments property (for Gmail and other tools)
      if (Array.isArray(obj.attachments)) {
        for (const file of obj.attachments) {
          if (file?.name && file.key && file.id) {
            if (!seenFileIds.has(file.id)) {
              seenFileIds.add(file.id)
              files.push({
                id: file.id,
                name: file.name,
                size: file.size,
                type: file.type,
                url: file.url,
                key: file.key,
                uploadedAt: file.uploadedAt,
                expiresAt: file.expiresAt,
                storageProvider: file.storageProvider,
                bucketName: file.bucketName,
              })
            }
          }
        }
      }

      // Check if this object itself is a file reference
      if (obj.name && obj.key && typeof obj.size === 'number') {
        if (!obj.id) {
          logger.warn(`File object missing ID, skipping: ${obj.name}`)
          return
        }

        if (!seenFileIds.has(obj.id)) {
          seenFileIds.add(obj.id)
          files.push({
            id: obj.id,
            name: obj.name,
            size: obj.size,
            type: obj.type,
            url: obj.url,
            key: obj.key,
            uploadedAt: obj.uploadedAt,
            expiresAt: obj.expiresAt,
            storageProvider: obj.storageProvider,
            bucketName: obj.bucketName,
          })
        }
      }

      // Recursively check nested objects and arrays
      if (Array.isArray(obj)) {
        obj.forEach((item, index) => extractFilesFromObject(item, `${source}[${index}]`))
      } else if (typeof obj === 'object') {
        Object.entries(obj).forEach(([key, value]) => {
          extractFilesFromObject(value, `${source}.${key}`)
        })
      }
    }

    // Extract files from trace spans
    if (traceSpans && Array.isArray(traceSpans)) {
      traceSpans.forEach((span, index) => {
        extractFilesFromObject(span, `trace_span_${index}`)
      })
    }

    // Extract files from final output
    if (finalOutput) {
      extractFilesFromObject(finalOutput, 'final_output')
    }

    return files
  }
}

export const executionLogger = new ExecutionLogger()
