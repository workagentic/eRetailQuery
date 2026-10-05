import { Body, Controller, Get, Post, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiBody, ApiTags } from '@nestjs/swagger';
import { zodToJsonSchema } from 'zod-to-json-schema';
import {
  createInviteInput,
  createOrgInput,
  type CreateInviteInput,
  type CreateOrgInput,
} from '@erq/shared';
import { AuthGuard } from '../auth/auth.guard';
import { CurrentOrg, CurrentUser, Roles } from '../auth/decorators';
import type { VerifiedUser } from '../auth/jwt-verifier';
import { OrgGuard } from '../auth/org.guard';
import type { OrgContext } from '../auth/request';
import { RolesGuard } from '../auth/roles.guard';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import { OrgsService } from './orgs.service';

// zod-to-json-schema returns a plain JSON schema object; Swagger accepts it as-is.
const bodyOf = (schema: Parameters<typeof zodToJsonSchema>[0]) => ({
  schema: zodToJsonSchema(schema) as Record<string, unknown>,
});

@ApiTags('orgs')
@ApiBearerAuth()
@Controller()
export class OrgsController {
  constructor(private readonly orgs: OrgsService) {}

  @Post('orgs')
  @UseGuards(AuthGuard)
  @ApiBody(bodyOf(createOrgInput))
  create(
    @CurrentUser() user: VerifiedUser,
    @Body(new ZodValidationPipe(createOrgInput)) body: CreateOrgInput,
  ) {
    return this.orgs.createOrg(user, body.name);
  }

  @Get('orgs/:orgId/members')
  @UseGuards(AuthGuard, OrgGuard, RolesGuard)
  members(@CurrentOrg() org: OrgContext) {
    return this.orgs.listMembers(org.orgId);
  }

  @Get('orgs/:orgId/invites')
  @Roles('admin')
  @UseGuards(AuthGuard, OrgGuard, RolesGuard)
  listInvites(@CurrentOrg() org: OrgContext) {
    return this.orgs.listPendingInvites(org.orgId);
  }

  @Post('orgs/:orgId/invites')
  @Roles('admin')
  @UseGuards(AuthGuard, OrgGuard, RolesGuard)
  @ApiBody(bodyOf(createInviteInput))
  invite(
    @CurrentOrg() org: OrgContext,
    @CurrentUser() user: VerifiedUser,
    @Body(new ZodValidationPipe(createInviteInput)) body: CreateInviteInput,
  ) {
    return this.orgs.createInvite(org.orgId, user, body);
  }
}
