import { Controller, Param, Post, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { InviteInvalidError } from '@erq/db';
import { AuthGuard } from '../auth/auth.guard';
import { CurrentUser } from '../auth/decorators';
import type { VerifiedUser } from '../auth/jwt-verifier';
import { ApiError } from '../common/api-error';
import { OrgsService } from './orgs.service';

@ApiTags('invites')
@ApiBearerAuth()
@Controller('invites')
@UseGuards(AuthGuard)
export class InvitesController {
  constructor(private readonly orgs: OrgsService) {}

  @Post(':token/accept')
  async accept(@CurrentUser() user: VerifiedUser, @Param('token') token: string) {
    try {
      return await this.orgs.acceptInvite(user, token);
    } catch (e) {
      if (e instanceof InviteInvalidError) {
        throw new ApiError(
          400,
          'invite_invalid',
          'This invite is invalid, expired, or was sent to a different email',
        );
      }
      throw e;
    }
  }
}
