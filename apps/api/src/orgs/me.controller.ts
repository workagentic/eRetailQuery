import { Controller, Get, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { AuthGuard } from '../auth/auth.guard';
import { CurrentUser } from '../auth/decorators';
import type { VerifiedUser } from '../auth/jwt-verifier';
import { OrgsService } from './orgs.service';

@ApiTags('me')
@ApiBearerAuth()
@Controller('me')
@UseGuards(AuthGuard)
export class MeController {
  constructor(private readonly orgs: OrgsService) {}

  @Get()
  me(@CurrentUser() user: VerifiedUser) {
    return this.orgs.me(user);
  }
}
