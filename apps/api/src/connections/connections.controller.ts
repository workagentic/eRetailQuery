import { Body, Controller, Get, Param, Post, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import {
  installShopifyInput,
  uuidSchema,
  type ConnectionDto,
  type InstallResponse,
  type InstallShopifyInput,
  type SyncNowResponse,
} from '@erq/shared';
import { AuthGuard } from '../auth/auth.guard';
import { CurrentOrg, CurrentUser, Roles } from '../auth/decorators';
import type { VerifiedUser } from '../auth/jwt-verifier';
import { OrgGuard } from '../auth/org.guard';
import type { OrgContext } from '../auth/request';
import { RolesGuard } from '../auth/roles.guard';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import { ConnectionsService } from './connections.service';

@ApiTags('connections')
@ApiBearerAuth()
@Controller()
export class ConnectionsController {
  constructor(private readonly connections: ConnectionsService) {}

  @Post('orgs/:orgId/connections/shopify/install')
  @Roles('admin')
  @UseGuards(AuthGuard, OrgGuard, RolesGuard)
  install(
    @CurrentOrg() org: OrgContext,
    @CurrentUser() user: VerifiedUser,
    @Body(new ZodValidationPipe(installShopifyInput)) body: InstallShopifyInput,
  ): Promise<InstallResponse> {
    return this.connections.startInstall(org.orgId, user.userId, body.shop);
  }

  @Get('orgs/:orgId/connections')
  @UseGuards(AuthGuard, OrgGuard, RolesGuard)
  list(@CurrentOrg() org: OrgContext): Promise<ConnectionDto[]> {
    return this.connections.list(org.orgId);
  }

  @Post('orgs/:orgId/connections/:id/disconnect')
  @Roles('admin')
  @UseGuards(AuthGuard, OrgGuard, RolesGuard)
  async disconnect(
    @CurrentOrg() org: OrgContext,
    @CurrentUser() user: VerifiedUser,
    @Param('id', new ZodValidationPipe(uuidSchema)) id: string,
  ): Promise<{ ok: true }> {
    await this.connections.disconnect(org.orgId, user.userId, id);
    return { ok: true };
  }

  @Post('orgs/:orgId/connections/:id/sync')
  @Roles('admin')
  @UseGuards(AuthGuard, OrgGuard, RolesGuard)
  sync(
    @CurrentOrg() org: OrgContext,
    @CurrentUser() user: VerifiedUser,
    @Param('id', new ZodValidationPipe(uuidSchema)) id: string,
  ): Promise<SyncNowResponse> {
    return this.connections.syncNow(org.orgId, user.userId, id);
  }
}
