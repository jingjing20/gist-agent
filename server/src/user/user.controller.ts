import { Controller, Get, Put, Body, Query, UseGuards } from '@nestjs/common';
import { UserService } from './user.service';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { CurrentUser } from '../auth/user.decorator';
import type { User } from '../auth/auth.service';

@Controller('users')
export class UserController {
	constructor(private readonly userService: UserService) { }

	@Get('search')
	search(@Query('q') q: string) {
		return this.userService.searchByEmail(q || '');
	}

	@UseGuards(JwtAuthGuard)
	@Put('profile')
	async updateProfile(@CurrentUser() user: User, @Body('name') name: string) {
		await this.userService.updateProfile(user.id, name);
		return { success: true };
	}

	@UseGuards(JwtAuthGuard)
	@Put('password')
	async updatePassword(@CurrentUser() user: User, @Body('password') password: string) {
		await this.userService.updatePassword(user.id, password);
		return { success: true };
	}
}
