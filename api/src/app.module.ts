import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { AuthController, AuthGuard } from './auth';
import { FilesController } from './files.controller';
import { InterventionsController } from './interventions.controller';
import { MiscController } from './misc.controller';
import { TasksController } from './tasks.controller';

@Module({
  controllers: [AuthController, TasksController, InterventionsController, FilesController, MiscController],
  providers: [{ provide: APP_GUARD, useClass: AuthGuard }],
})
export class AppModule {}
