import { Module } from '@nestjs/common';
import { InvitesController } from './invites.controller';
import { MeController } from './me.controller';
import { OrgsController } from './orgs.controller';
import { OrgsService } from './orgs.service';

@Module({
  controllers: [MeController, OrgsController, InvitesController],
  providers: [OrgsService],
})
export class OrgsModule {}
