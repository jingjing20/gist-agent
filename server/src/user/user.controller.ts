import { Controller, Get, Query } from '@nestjs/common';
import { UserService } from './user.service';

@Controller('users')
export class UserController {
	constructor(private readonly userService: UserService) { }

	@Get('search')
	search(@Query('q') q: string) {
		return this.userService.searchByEmail(q || '');
	}
}
