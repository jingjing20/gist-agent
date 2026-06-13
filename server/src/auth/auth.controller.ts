import { Controller, Post, Body, BadRequestException } from "@nestjs/common";
import { AuthService } from "./auth.service";
import { Public } from "./public.decorator";
import { CurrentUser } from "./user.decorator";
import type { User } from "./auth.service";

@Controller("auth")
export class AuthController {
  constructor(private readonly authService: AuthService) {}

  @Public()
  @Post("register")
  async register(
    @Body() body: { email: string; password: string; name?: string },
  ) {
    const { email, password, name } = body;
    if (!email?.trim() || !password?.trim()) {
      throw new BadRequestException("邮箱和密码不能为空");
    }
    if (password.length < 6) {
      throw new BadRequestException("密码至少 6 位");
    }
    return this.authService.register(email, password, name || "");
  }

  @Public()
  @Post("login")
  async login(@Body() body: { email: string; password: string }) {
    const { email, password } = body;
    if (!email?.trim() || !password?.trim()) {
      throw new BadRequestException("邮箱和密码不能为空");
    }
    return this.authService.login(email, password);
  }

  @Public()
  @Post("forgot-password")
  async forgotPassword(@Body() body: { email: string; origin?: string }) {
    if (!body.email?.trim()) {
      throw new BadRequestException("邮箱不能为空");
    }
    await this.authService.requestReset(body.email, body.origin);
    return { message: "若该邮箱已注册，重置链接已发送，请查收邮件" };
  }

  @Public()
  @Post("reset-password")
  async resetPassword(@Body() body: { token: string; password: string }) {
    await this.authService.resetPassword(body.token, body.password);
    return { message: "密码已重置，请重新登录" };
  }

  @Post("me")
  async me(@CurrentUser() user: User) {
    return user;
  }
}
