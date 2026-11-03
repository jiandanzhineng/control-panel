const express = require('express');
const request = require('supertest');

jest.mock('../services/accountService', () => {
  class UpstreamError extends Error {
    constructor(status, code, message) {
      super(message);
      this.status = status;
      this.code = code;
    }
  }
  return {
    UpstreamError,
    register: jest.fn(),
    phoneStatus:jest.fn(),phoneCode:jest.fn(),phoneLogin:jest.fn(),phoneBind:jest.fn(),
    login: jest.fn(),
    logout: jest.fn(),
    recovery: jest.fn(),
    getMe: jest.fn(),
    deleteMe: jest.fn(),
    getBaseUrl: jest.fn(() => 'https://api.undersilicon.cn'),
  };
});

jest.mock('../utils/logger', () => ({
  info: jest.fn(),
  error: jest.fn(),
  warn: jest.fn(),
}));

jest.mock('../services/wechatQrService', () => ({ start: jest.fn(), status: jest.fn() }));
const wechatQr = require('../services/wechatQrService');
const accountService = require('../services/accountService');

function createApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/auth', require('../routes/auth'));
  return app;
}

const USER = { id: '01HX', email: 'a@b.com', provider: 'email', createdAt: '2026-01-01T00:00:00Z' };

describe('auth routes', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('logs in and passes through token + user', async () => {
    accountService.login.mockResolvedValue({ status: 200, data: { token: 'jwt-token', user: USER } });

    const res = await request(createApp())
      .post('/api/auth/login')
      .send({ email: 'a@b.com', password: 'secret123' });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ token: 'jwt-token', user: USER });
    expect(accountService.login).toHaveBeenCalledWith('a@b.com', 'secret123');
  });

  it('passes through upstream 401 on bad credentials', async () => {
    accountService.login.mockRejectedValue(
      new accountService.UpstreamError(401, 'UNAUTHORIZED', 'Invalid credentials'),
    );

    const res = await request(createApp())
      .post('/api/auth/login')
      .send({ email: 'a@b.com', password: 'wrong-password' });

    expect(res.status).toBe(401);
    expect(res.body.error).toEqual({ code: 'UNAUTHORIZED', message: 'Invalid credentials' });
  });

  it('passes through upstream 409 on register conflict', async () => {
    accountService.register.mockRejectedValue(
      new accountService.UpstreamError(409, 'CONFLICT', 'Email already registered'),
    );

    const res = await request(createApp())
      .post('/api/auth/register')
      .send({ email: 'a@b.com', password: 'secret123' });

    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('CONFLICT');
  });

  it('rejects invalid email / short password before hitting upstream', async () => {
    const app = createApp();

    const badEmail = await request(app)
      .post('/api/auth/register')
      .send({ email: 'not-an-email', password: 'secret123' });
    expect(badEmail.status).toBe(400);
    expect(badEmail.body.error.code).toBe('INVALID_EMAIL');

    const shortPw = await request(app)
      .post('/api/auth/register')
      .send({ email: 'a@b.com', password: 'short' });
    expect(shortPw.status).toBe(400);
    expect(shortPw.body.error.code).toBe('INVALID_PASSWORD');

    expect(accountService.register).not.toHaveBeenCalled();
  });

  it('returns 401 when bearer token is missing', async () => {
    const res = await request(createApp()).get('/api/auth/me');

    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('MISSING_TOKEN');
    expect(accountService.getMe).not.toHaveBeenCalled();
  });

  it('passes bearer token through to /me', async () => {
    accountService.getMe.mockResolvedValue({ status: 200, data: { user: USER } });

    const res = await request(createApp())
      .get('/api/auth/me')
      .set('Authorization', 'Bearer jwt-token');

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ user: USER });
    expect(accountService.getMe).toHaveBeenCalledWith('jwt-token');
  });

  it('maps unreachable upstream to 502', async () => {
    accountService.login.mockRejectedValue(
      new accountService.UpstreamError(502, 'UPSTREAM_UNREACHABLE', '账号服务器不可达，请检查网络'),
    );

    const res = await request(createApp())
      .post('/api/auth/login')
      .send({ email: 'a@b.com', password: 'secret123' });

    expect(res.status).toBe(502);
    expect(res.body.error.code).toBe('UPSTREAM_UNREACHABLE');
  });

  it('logout / deleteMe return 204', async () => {
    accountService.logout.mockResolvedValue({ status: 204, data: null });
    accountService.deleteMe.mockResolvedValue({ status: 204, data: null });

    const app = createApp();
    const logoutRes = await request(app)
      .post('/api/auth/logout')
      .set('Authorization', 'Bearer jwt-token');
    expect(logoutRes.status).toBe(204);

    const deleteRes = await request(app)
      .delete('/api/auth/me')
      .set('Authorization', 'Bearer jwt-token');
    expect(deleteRes.status).toBe(204);
    expect(accountService.deleteMe).toHaveBeenCalledWith('jwt-token');
  });
});

it('phone routes preserve bearer binding and pass nullable email without local account creation',async()=>{
 const phoneUser={...USER,email:null,provider:'phone',phoneVerified:true,phoneMasked:'+86138****0000'};
 accountService.phoneCode.mockResolvedValue({status:200,data:{challengeId:'challenge',retryAfter:60,expiresIn:300}});
 let res=await request(createApp()).post('/api/auth/phone/code').set('authorization','Bearer current').send({phone:'13800000000',purpose:'bind',accountId:'attacker'});
 expect(res.status).toBe(200);expect(accountService.phoneCode).toHaveBeenCalledWith({phone:'13800000000',purpose:'bind'},'current');
 res=await request(createApp()).post('/api/auth/phone/bind').send({challengeId:'challenge',code:'123456'});expect(res.status).toBe(401);
 accountService.phoneLogin.mockResolvedValue({status:200,data:{token:'phone-token',user:phoneUser}});
 res=await request(createApp()).post('/api/auth/phone/login').send({challengeId:'challenge',code:'123456'});expect(res.status).toBe(200);expect(res.body.user.email).toBeNull();
 accountService.phoneBind.mockRejectedValue(new accountService.UpstreamError(409,'CONFLICT','phone in use'));
 res=await request(createApp()).post('/api/auth/phone/bind').set('authorization','Bearer current').send({challengeId:'challenge',code:'123456'});expect(res.status).toBe(409);
});


it('desktop QR proxy validates input and forwards only the QR proof', async () => {
  const app = createApp();
  const invalid = await request(app).post('/api/auth/wechat/qr/status').send({ id: 'bad', secret: 'bad' });
  expect(invalid.status).toBe(400);
  expect(wechatQr.status).not.toHaveBeenCalled();
  wechatQr.start.mockResolvedValue({ id: 'abcdefgh12345678', webSecret: 'a'.repeat(24), image: 'data:image/png;base64,test' });
  const started = await request(app).post('/api/auth/wechat/qr/start').send({ accountId: 'attacker' });
  expect(started.status).toBe(200);
  expect(started.headers['cache-control']).toBe('no-store');
  wechatQr.status.mockResolvedValue({ status: 'ok', token: 'center-token', user: USER });
  const input = { id: 'abcdefgh12345678', secret: 'a'.repeat(24) };
  const result = await request(app).post('/api/auth/wechat/qr/status').send({ ...input, accountId: 'attacker', token: 'fake' });
  expect(wechatQr.status).toHaveBeenCalledWith(input);
  expect(result.body).toEqual({ status: 'ok', token: 'center-token', user: USER });
});
