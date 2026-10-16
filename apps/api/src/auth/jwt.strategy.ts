import { jwtSecret } from '@gist/config';
import { Injectable, UnauthorizedException } from '@nestjs/common';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';
import { AuthService } from './auth.service';

export interface JwtPayload {
    sub: number;
    email: string;
    credentialsVersion: string;
}

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy) {
    constructor(private readonly authService: AuthService) {
        super({
            jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
            ignoreExpiration: false,
            secretOrKey: jwtSecret(),
        });
    }

    async validate(payload: JwtPayload) {
        if (typeof payload.credentialsVersion !== 'string') throw new UnauthorizedException('请重新登录');
        const user = await this.authService.findById(payload.sub, payload.credentialsVersion);
        if (!user) {
            throw new UnauthorizedException();
        }
        return user;
    }
}
