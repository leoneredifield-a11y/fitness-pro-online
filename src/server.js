import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { createClient } from '@supabase/supabase-js';

const { SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY, SUPABASE_SECRET_KEY } = process.env;
const port = Number(process.env.PORT || 3000);
const appOrigin = new URL(process.env.APP_URL || process.env.RENDER_EXTERNAL_URL || 'http://localhost:' + port).origin;
const supabaseOrigin = new URL(SUPABASE_URL).origin;
if (!SUPABASE_PUBLISHABLE_KEY || !SUPABASE_SECRET_KEY ||
    SUPABASE_PUBLISHABLE_KEY === SUPABASE_SECRET_KEY ||
    !SUPABASE_PUBLISHABLE_KEY.startsWith('sb_publishable_') ||
    !SUPABASE_SECRET_KEY.startsWith('sb_secret_')) {
  throw new Error('Configure as chaves publishable e secret do Supabase no ambiente do servidor.');
}

const clientOptions = {
  auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  global: { fetch: (input, options) => fetch(input, { ...options, signal: AbortSignal.any([AbortSignal.timeout(8000), ...(options?.signal ? [options.signal] : [])]) }) },
};
const admin = createClient(SUPABASE_URL, SUPABASE_SECRET_KEY, clientOptions);
const auth = createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY, clientOptions);
const redirectTo = new URL('/?senha=1', appOrigin).href;

const html = (await readFile(new URL('../public/index.html', import.meta.url), 'utf8')).replace(/\r\n?/g, '\n');
const hashes = Array.from(html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi))
  .filter(([, body]) => body.trim())
  .map(([, body]) => "'sha256-" + createHash('sha256').update(body).digest('base64') + "'");
const assets = new Map([
  ['/', ['text/html; charset=utf-8', html]],
  ['/online.js', ['text/javascript; charset=utf-8', await readFile(new URL('../public/online.js', import.meta.url))]],
  ['/supabase.js', ['text/javascript; charset=utf-8', await readFile(new URL('../node_modules/@supabase/supabase-js/dist/umd/supabase.js', import.meta.url))]],
]);

function send(res, status, value) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(value));
}

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

async function readJson(req) {
  if (req.headers['content-type']?.split(';')[0] !== 'application/json') {
    throw new HttpError(415, 'Envie JSON.');
  }
  let bytes = 0;
  const chunks = [];
  for await (const chunk of req.iterator({ destroyOnReturn: false })) {
    bytes += chunk.length;
    if (bytes > 4096) throw new HttpError(413, 'Solicitação muito grande.');
    chunks.push(chunk);
  }
  try {
    const data = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error();
    return data;
  } catch {
    throw new HttpError(400, 'JSON inválido.');
  }
}

async function requireOwner(req) {
  const token = req.headers.authorization?.match(/^Bearer ([^\s]+)$/i)?.[1];
  if (!token) throw new HttpError(401, 'Entre novamente na sua conta.');
  const { data, error } = await auth.auth.getUser(token);
  if (error && (!error.status || error.status >= 500)) throw error;
  if (!data?.user || error) throw new HttpError(401, 'Entre novamente na sua conta.');
  const role = await admin.from('user_roles').select('role')
    .eq('user_id', data.user.id).eq('role', 'owner').maybeSingle();
  if (role.error) throw role.error;
  if (!role.data) throw new HttpError(403, 'Acesso restrito ao Administrador Master.');
}

async function listUsers(url) {
  const page = Number(url.searchParams.get('page') ?? '1');
  if (!Number.isSafeInteger(page) || page < 1) throw new HttpError(400, 'Página inválida.');
  const { data, error } = await admin.auth.admin.listUsers({ page, perPage: 50 });
  if (error) throw error;
  if (!data.users.length) return { users: [], nextPage: null };
  const ids = data.users.map(user => user.id);
  const [profiles, roles] = await Promise.all([
    admin.from('profiles').select('id, full_name, training_access').in('id', ids),
    admin.from('user_roles').select('user_id, role').in('user_id', ids).neq('role', 'member'),
  ]);
  if (profiles.error || roles.error) throw profiles.error || roles.error;
  const byId = new Map(profiles.data.map(profile => [profile.id, profile]));
  const protectedIds = new Set(roles.data.map(role => role.user_id));
  return {
    users: data.users.map(user => ({
      id: user.id,
      email: user.email,
      name: byId.get(user.id)?.full_name,
      trainingAccess: byId.get(user.id)?.training_access ?? 'both',
      protected: protectedIds.has(user.id),
      confirmed: Boolean(user.email_confirmed_at),
    })),
    nextPage: data.nextPage,
  };
}

const uuid = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const userRoute = new RegExp('^/api/admin/users/(' + uuid + ')(/reset)?$', 'i');

async function handleAdmin(req, res, url) {
  await requireOwner(req);
  if (url.pathname === '/api/admin/users') {
    if (req.method === 'GET') return send(res, 200, await listUsers(url));
    if (req.method === 'POST') {
      const { email, name, trainingAccess } = await readJson(req);
      if (typeof email !== 'string' || email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ||
          typeof name !== 'string' || !name.trim() || name.length > 120 ||
          !['male', 'female', 'both'].includes(trainingAccess)) {
        throw new HttpError(400, 'Informe nome, e-mail válido e acesso de treino.');
      }
      const { error } = await admin.auth.admin.inviteUserByEmail(email.toLowerCase(), {
        redirectTo,
        data: { full_name: name.trim(), training_access: trainingAccess },
      });
      if (error?.code === 'email_exists' || error?.code === 'user_already_exists') {
        throw new HttpError(409, 'Já existe uma conta com esse e-mail.');
      }
      if (error) throw error;
      return send(res, 201, { ok: true });
    }
  }

  const route = url.pathname.match(userRoute);
  if (route && ((req.method === 'DELETE' && !route[2]) || (req.method === 'POST' && route[2]))) {
    const id = route[1];
    const roles = await admin.from('user_roles').select('role').eq('user_id', id).neq('role', 'member').limit(1);
    if (roles.error) throw roles.error;
    if (roles.data.length) throw new HttpError(403, 'Gerencie contas da equipe pelo Supabase.');
    if (req.method === 'DELETE') {
      const { error } = await admin.auth.admin.deleteUser(id);
      if (error?.status === 404) throw new HttpError(404, 'Conta já removida ou inexistente.');
      if (error) throw error;
      return send(res, 200, { ok: true });
    }
    const { data, error } = await admin.auth.admin.getUserById(id);
    if (error?.status === 404 || !error && !data.user?.email) throw new HttpError(404, 'Conta sem e-mail disponível.');
    if (error) throw error;
    const authResult = data.user.email_confirmed_at
      ? await auth.auth.resetPasswordForEmail(data.user.email, { redirectTo })
      : await admin.auth.admin.inviteUserByEmail(data.user.email, { redirectTo });
    if (authResult.error) throw authResult.error;
    return send(res, 200, { ok: true });
  }

  throw new HttpError(404, 'Rota inexistente.');
}

const server = createServer(async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Content-Security-Policy', [
    "default-src 'none'", "base-uri 'none'", "frame-ancestors 'none'",
    "form-action 'self'", "style-src 'self' 'unsafe-inline'", "img-src 'self' data: blob:",
    "connect-src 'self' " + supabaseOrigin, "script-src 'self' " + hashes.join(' '),
  ].join('; '));

  try {
    const url = new URL(req.url, appOrigin);
    const asset = assets.get(url.pathname);
    if (asset && ['GET', 'HEAD'].includes(req.method)) {
      res.writeHead(200, { 'Content-Type': asset[0] });
      return res.end(req.method === 'HEAD' ? undefined : asset[1]);
    }
    if (url.pathname === '/health' && req.method === 'GET') {
      const { error } = await admin.from('fitness_state').select('user_id', { head: true }).limit(1).abortSignal(AbortSignal.timeout(3500));
      return send(res, error ? 503 : 200, { ok: !error });
    }
    if (url.pathname === '/api/config' && req.method === 'GET') {
      return send(res, 200, { url: SUPABASE_URL, key: SUPABASE_PUBLISHABLE_KEY, redirectTo });
    }
    if (url.pathname.startsWith('/api/admin/')) return await handleAdmin(req, res, url);
    send(res, 404, { error: 'Rota inexistente.' });
  } catch (error) {
    if (!error.status || error.status >= 500) {
      console.error('Falha na requisição', error.code ?? error.name ?? 'erro');
    }
    const status = error instanceof HttpError ? error.status : error.status === 429 ? 429 : 503;
    if (!res.headersSent) send(res, status, {
      error: error instanceof HttpError ? error.message : 'Serviço indisponível. Tente novamente.',
    });
  }
});
server.listen(port, '0.0.0.0', () => console.log('Fitness Pro ouvindo na porta ' + port));
process.on('SIGTERM', () => server.close());
