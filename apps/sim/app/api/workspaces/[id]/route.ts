import { and, eq } from 'drizzle-orm'
import { type NextRequest, NextResponse } from 'next/server'
import { getSession } from '@/lib/auth'
import { createLogger } from '@/lib/logs/console/logger'
import { workflow } from '@/db/schema'
import * as traceroot from 'traceroot-sdk-ts'

const traceroot_logger = traceroot.get_logger('WorkspaceByIdAPI')
const logger = createLogger('WorkspaceByIdAPI')

import { getUserEntityPermissions } from '@/lib/permissions/utils'
import { db } from '@/db'
import { knowledgeBase, permissions, workspace } from '@/db/schema'

export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const requestId = crypto.randomUUID().slice(0, 8)
      
  // Log all params
  console.log({ workspaceId: id }, `[${requestId}] GET params: ${id}`)
  traceroot_logger.info({ workspaceId: id, requestId }, `[${requestId}] GET params: ${id}`)

  const getWorkspaceDetails = traceroot.traceFunction(
    async function getWorkspaceDetails() {
      console.log(`[${requestId}] getWorkspaceDetails GET params: ${id}`)
      traceroot_logger.info({ workspaceId: id, requestId }, `[${requestId}] getWorkspaceDetails GET params: ${id}`)

      try {
        const session = await getSession()

        if (!session?.user?.id) {
          logger.warn(`[${requestId}] Unauthorized workspace access attempt`)
          traceroot_logger.warn({ workspaceId: id, requestId }, `[${requestId}] Unauthorized workspace access attempt`)
          return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
        }

        const workspaceId = id

        // Check if user has any access to this workspace
        const userPermission = await getUserEntityPermissions(session.user.id, 'workspace', workspaceId)
        if (!userPermission) {
          logger.warn(`[${requestId}] Workspace not found or access denied: ${workspaceId}`)
          traceroot_logger.warn({ workspaceId, requestId }, `[${requestId}] Workspace not found or access denied: ${workspaceId}`)
          return NextResponse.json({ error: 'Workspace not found or access denied' }, { status: 404 })
        }

        // Get workspace details
        const workspaceDetails = await db
          .select()
          .from(workspace)
          .where(eq(workspace.id, workspaceId))
          .then((rows) => rows[0])

        if (!workspaceDetails) {
          logger.warn(`[${requestId}] Workspace not found: ${workspaceId}`)
          traceroot_logger.warn({ workspaceId, requestId }, `[${requestId}] Workspace not found: ${workspaceId}`)
          return NextResponse.json({ error: 'Workspace not found' }, { status: 404 })
        }

        logger.info(`[${requestId}] Successfully retrieved workspace: ${workspaceId}`)
        traceroot_logger.info({ workspaceId, requestId }, `[${requestId}] Successfully retrieved workspace: ${workspaceId}`)

        return NextResponse.json({
          workspace: {
            ...workspaceDetails,
            permissions: userPermission,
          },
        })
      } catch (error: any) {
        logger.error(`[${requestId}] Workspace fetch error`, error)
        traceroot_logger.error({ workspaceId: id, requestId }, `[${requestId}] Workspace fetch error`, error)
        return NextResponse.json({ error: error.message }, { status: 500 })
      }
    },
    { spanName: 'getWorkspaceDetails', traceParams: true }
  )

  return await getWorkspaceDetails()
}

export async function PATCH(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const requestId = crypto.randomUUID().slice(0, 8)
  
  // Log all params
  console.log(`[${requestId}] PATCH params:`, { workspaceId: id, requestId })
  traceroot_logger.info({ workspaceId: id, requestId }, `[${requestId}] PATCH params:`)

  const updateWorkspace = traceroot.traceFunction(
    async function updateWorkspace() {
      console.log(`[${requestId}] updateWorkspace PATCH params: ${id}`)
      traceroot_logger.info({ workspaceId: id, requestId }, `[${requestId}] updateWorkspace PATCH params: ${id}`)

      try {
        const session = await getSession()

        if (!session?.user?.id) {
          logger.warn(`[${requestId}] Unauthorized workspace update attempt`)
          traceroot_logger.warn({ workspaceId: id, requestId }, `[${requestId}] Unauthorized workspace update attempt`)
          return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
        }

        const workspaceId = id

        // Check if user has admin permissions to update workspace
        const userPermission = await getUserEntityPermissions(session.user.id, 'workspace', workspaceId)
        if (userPermission !== 'admin') {
          logger.warn(`[${requestId}] Insufficient permissions for workspace update: ${workspaceId}`)
          traceroot_logger.warn({ workspaceId, requestId }, `[${requestId}] Insufficient permissions for workspace update: ${workspaceId}`)
          return NextResponse.json({ error: 'Insufficient permissions' }, { status: 403 })
        }

        const { name } = await request.json()

        if (!name) {
          logger.warn(`[${requestId}] Name is required for workspace update`)
          traceroot_logger.warn({ workspaceId: id, requestId }, `[${requestId}] Name is required for workspace update`)
          return NextResponse.json({ error: 'Name is required' }, { status: 400 })
        }

        // Update workspace
        await db
          .update(workspace)
          .set({
            name,
            updatedAt: new Date(),
          })
          .where(eq(workspace.id, workspaceId))

        // Get updated workspace
        const updatedWorkspace = await db
          .select()
          .from(workspace)
          .where(eq(workspace.id, workspaceId))
          .then((rows) => rows[0])

        logger.info(`[${requestId}] Successfully updated workspace: ${workspaceId}`)
        traceroot_logger.info({ workspaceId, requestId }, `[${requestId}] Successfully updated workspace: ${workspaceId}`)

        return NextResponse.json({
          workspace: {
            ...updatedWorkspace,
            permissions: userPermission,
          },
        })
      } catch (error: any) {
        logger.error(`[${requestId}] Error updating workspace`, error)
        traceroot_logger.error({ workspaceId: id, requestId }, `[${requestId}] Error updating workspace`, error)
        return NextResponse.json({ error: 'Failed to update workspace' }, { status: 500 })
      }
    },
    { spanName: 'updateWorkspace', traceParams: true }
  )

  return await updateWorkspace()
}

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params
  const requestId = crypto.randomUUID().slice(0, 8)
  
  // Log all params
  console.log(`[${requestId}] DELETE params:`, { workspaceId: id, requestId })
  traceroot_logger.info({ workspaceId: id, requestId }, `[${requestId}] DELETE params:`)

  const deleteWorkspace = traceroot.traceFunction(
    async function deleteWorkspace() {
      console.log(`[${requestId}] deleteWorkspace DELETE params: ${id}`)
      traceroot_logger.info({ workspaceId: id, requestId }, `[${requestId}] deleteWorkspace DELETE params: ${id}`)

      try {
        const session = await getSession()

        if (!session?.user?.id) {
          logger.warn(`[${requestId}] Unauthorized workspace delete attempt`)
          traceroot_logger.warn({ workspaceId: id, requestId }, `[${requestId}] Unauthorized workspace delete attempt`)
          return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
        }

        const workspaceId = id

        // Check if user has admin permissions to delete workspace
        const userPermission = await getUserEntityPermissions(session.user.id, 'workspace', workspaceId)
        if (userPermission !== 'admin') {
          logger.warn(`[${requestId}] Insufficient permissions for workspace delete: ${workspaceId}`)
          traceroot_logger.warn({ workspaceId, requestId }, `[${requestId}] Insufficient permissions for workspace delete: ${workspaceId}`)
          return NextResponse.json({ error: 'Insufficient permissions' }, { status: 403 })
        }

        logger.info(`[${requestId}] Deleting workspace ${workspaceId} for user ${session.user.id}`)
        traceroot_logger.info({ workspaceId, requestId }, `[${requestId}] Deleting workspace ${workspaceId} for user ${session.user.id}`)

        // Delete workspace and all related data in a transaction
        await db.transaction(async (tx) => {
          // Delete all workflows in the workspace - database cascade will handle all workflow-related data
          // The database cascade will handle deleting related workflow_blocks, workflow_edges, workflow_subflows,
          // workflow_logs, workflow_execution_snapshots, workflow_execution_logs, workflow_execution_trace_spans,
          // workflow_schedule, webhook, marketplace, chat, and memory records
          await tx.delete(workflow).where(eq(workflow.workspaceId, workspaceId))

          // Clear workspace ID from knowledge bases instead of deleting them
          // This allows knowledge bases to become "unassigned" rather than being deleted
          await tx
            .update(knowledgeBase)
            .set({ workspaceId: null, updatedAt: new Date() })
            .where(eq(knowledgeBase.workspaceId, workspaceId))

          // Delete all permissions associated with this workspace
          await tx
            .delete(permissions)
            .where(and(eq(permissions.entityType, 'workspace'), eq(permissions.entityId, workspaceId)))

          // Delete the workspace itself
          await tx.delete(workspace).where(eq(workspace.id, workspaceId))

          logger.info(`[${requestId}] Successfully deleted workspace ${workspaceId} and all related data`)
          traceroot_logger.info({ workspaceId, requestId }, `[${requestId}] Successfully deleted workspace ${workspaceId} and all related data`)
        })

        return NextResponse.json({ success: true })
      } catch (error: any) {
        logger.error(`[${requestId}] Error deleting workspace ${id}:`, error)
        traceroot_logger.error({ workspaceId: id, requestId }, `[${requestId}] Error deleting workspace ${id}:`, error)
        return NextResponse.json({ error: 'Failed to delete workspace' }, { status: 500 })
      }
    },
    { spanName: 'deleteWorkspace', traceParams: true }
  )

  return await deleteWorkspace()
}

export async function PUT(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const requestId = crypto.randomUUID().slice(0, 8)
  
  // Log all params
  console.log(`[${requestId}] PUT params:`, { workspaceId: id, requestId })
  traceroot_logger.info({ workspaceId: id, requestId }, `[${requestId}] PUT params:`)

  const putWorkspace = traceroot.traceFunction(
    async function putWorkspace() {
      console.log(`[${requestId}] putWorkspace PUT params: ${id}`)
      traceroot_logger.info({ workspaceId: id, requestId }, `[${requestId}] putWorkspace PUT params: ${id}`)
      
      // Reuse the PATCH handler implementation for PUT requests
      return PATCH(request, { params })
    },
    { spanName: 'putWorkspace', traceParams: true }
  )

  return await putWorkspace()
}
