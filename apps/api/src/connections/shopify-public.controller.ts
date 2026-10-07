import { Controller, HttpCode, Post, Req, type RawBodyRequest } from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';
import type { Request } from 'express';
import { ConnectionsService } from './connections.service';

@ApiExcludeController()
@Controller()
export class ShopifyPublicController {
  constructor(private readonly connections: ConnectionsService) {}

  // Public by design: authorized only by Shopify's HMAC over the raw request body.
  @Post('webhooks/shopify')
  @HttpCode(200)
  async webhook(@Req() req: RawBodyRequest<Request>): Promise<{ ok: true }> {
    await this.connections.receiveWebhook(req.rawBody, req.headers);
    return { ok: true };
  }
}
