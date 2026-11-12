import {
  CanActivate, Controller, ExecutionContext, Injectable, SetMetadata,
  UnauthorizedException, Body, Post,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';

export const IS_PUBLIC = 'isPublic';
export const Public = () => SetMetadata(IS_PUBLIC, true);

const OPS_USER = process.env.OPS_USER || 'admin';
const OPS_PASS = process.env.OPS_PASS || 'admin123';
export const OPS_TOKEN = process.env.OPS_TOKEN || 'dev-ops-token';

@Injectable()
export class AuthGuard implements CanActivate {
  constructor(private reflector: Reflector) {}
  canActivate(ctx: ExecutionContext): boolean {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC, [ctx.getHandler(), ctx.getClass()]);
    if (isPublic) return true;
    const req = ctx.switchToHttp().getRequest();
    const h: string = req.headers['authorization'] || '';
    if (h === `Bearer ${OPS_TOKEN}`) return true;
    throw new UnauthorizedException('未登录或令牌无效');
  }
}

@Controller('auth')
export class AuthController {
  @Public()
  @Post('login')
  login(@Body() body: { username?: string; password?: string }) {
    if (body?.username === OPS_USER && body?.password === OPS_PASS) {
      return { token: OPS_TOKEN, user: OPS_USER };
    }
    throw new UnauthorizedException('用户名或密码错误');
  }
}
