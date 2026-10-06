import { Controller, Get, Query, Res } from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';
import type { Response } from 'express';
import { ConnectionsService } from './connections.service';

@ApiExcludeController()
@Controller()
export class ShopifyPublicController {
  constructor(private readonly connections: ConnectionsService) {}

  // Public by design: authorized by Shopify's query HMAC plus the single-use state, never by a session.
  @Get('connections/shopify/callback')
  async callback(
    @Query() query: Record<string, string | string[] | undefined>,
    @Res() res: Response,
  ): Promise<void> {
    res.redirect(302, await this.connections.completeInstall(query));
  }
}
