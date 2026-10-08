/*
 *   Copyright (c) 2026 妙码学院 @Heyi
 *   All rights reserved.
 *   妙码学院官方出品，作者 @Heyi，供学员学习使用，可用作练习，可用作美化简历，不可开源。
 */

import { Module } from '@nestjs/common'
import { ConfigModule } from '@nestjs/config'

import { WorkflowModule } from './modules/workflow/workflow.module'
import { PrismaModule } from './prisma/prisma.module'

@Module({
    imports: [
        // 环境变量配置
        ConfigModule.forRoot({
            isGlobal: true,
            envFilePath: '.env',
        }),

        // 数据库
        PrismaModule,

        // 业务模块
        WorkflowModule,
    ],
    controllers: [],
    providers: [],
})
export class AppModule {}
