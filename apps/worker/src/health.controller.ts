import { Controller, Get } from '@nestjs/common';

@Controller('health')
export class HealthController {
  @Get()
  health(): { status: 'ok'; process: 'worker' } {
    return { status: 'ok', process: 'worker' };
  }
}
