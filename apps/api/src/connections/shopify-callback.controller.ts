import { Body, Controller, HttpCode, Post, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import {
  shopifyCallbackInput,
  type ShopifyCallbackInput,
  type ShopifyCallbackResponse,
} from '@erq/shared';
import { AuthGuard } from '../auth/auth.guard';
import { CurrentUser } from '../auth/decorators';
import type { VerifiedUser } from '../auth/jwt-verifier';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import { ConnectionsService } from './connections.service';

@ApiTags('connections')
@ApiBearerAuth()
@Controller()
export class ShopifyCallbackController {
  constructor(private readonly connections: ConnectionsService) {}

  // Authenticated, but not org-scoped: the org comes from the single-use state minted at install, and the service
  // requires the caller to be the user who started it and still an owner or admin of that org.
  @Post('connections/shopify/callback')
  @UseGuards(AuthGuard)
  @HttpCode(200)
  async callback(
    @CurrentUser() user: VerifiedUser,
    @Body(new ZodValidationPipe(shopifyCallbackInput)) body: ShopifyCallbackInput,
  ): Promise<ShopifyCallbackResponse> {
    return { redirectTo: await this.connections.completeInstall(user.userId, body.query) };
  }
}
