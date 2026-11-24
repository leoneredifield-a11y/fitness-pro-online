# Fitness Pro

Aplicação web em português. O Render serve a interface e as rotas administrativas em Node.js 24. O Supabase autentica as contas e guarda o estado de cada perfil. O acesso é por e-mail e senha. O Administrador Master gerencia contas por convite.

## 1. Configurar o Supabase

1. Crie ou selecione o projeto e mantenha a Data API habilitada. No SQL Editor, execute os arquivos em ordem:
   - `supabase/migrations/001_initial_schema.sql` para um projeto que ainda não recebeu o esquema original.
   - `supabase/migrations/002_online_fitness_state.sql` para adicionar a integração online. Execute cada migração uma vez.
2. Em Authentication, habilite o provedor Email, configure uma senha mínima de 10 caracteres e desabilite o cadastro público se o acesso for apenas por convite.
3. Configure SMTP próprio no Supabase para enviar convites e links de recuperação aos usuários. Use os templates padrão de Invite e Reset Password, com `{{ .ConfirmationURL }}`. Desative rastreamento de cliques no provedor SMTP se ele reescrever links de autenticação.
4. Em Authentication → Users, crie a primeira conta e confirme o e-mail. Depois, no SQL Editor, substitua o e-mail abaixo pelo da conta administrativa e confirme que a consulta retornou o ID esperado.

```sql
insert into public.user_roles (user_id, role)
select id, 'owner'::public.app_role
from auth.users
where lower(email) = lower('admin@exemplo.com')
on conflict do nothing
returning user_id;
```

[Permissões da Data API](https://supabase.com/docs/guides/api/securing-your-api) · [SMTP no Supabase](https://supabase.com/docs/guides/auth/auth-smtp) · [Templates de e-mail](https://supabase.com/docs/guides/auth/auth-email-templates)

## 2. Publicar no Render

1. Coloque o conteúdo desta pasta na raiz de um repositório Git que o Render possa acessar. No Render, crie um Blueprint a partir do repositório. O `render.yaml` configura Node.js, build com `npm ci`, início com `npm start` e verificação em `/health`.
2. Nas variáveis do serviço, informe `SUPABASE_URL` com a URL do projeto, `SUPABASE_PUBLISHABLE_KEY` com a chave pública `sb_publishable_...` e `SUPABASE_SECRET_KEY` com a chave de servidor `sb_secret_...`. A chave de servidor fica nas variáveis do Render.
3. Em Authentication → URL Configuration no Supabase, configure **Site URL** com o endereço público gerado pelo Render, por exemplo `https://fitness-pro.onrender.com`. Em **Redirect URLs**, inclua o endereço exato com `/?senha=1`, por exemplo `https://fitness-pro.onrender.com/?senha=1`. Se usar domínio próprio, defina também `APP_URL` no Render com a origem final.
4. Abra `/health` na URL do serviço e confira `{"ok":true}`. Entre com a conta Master, convide uma conta de teste e confirme o recebimento do convite. Defina a senha, registre uma refeição e confira o mesmo registro em outro navegador. Teste a recuperação de senha e a exclusão dessa conta de teste pela tela Master.

[Blueprints do Render](https://render.com/docs/blueprint-spec) · [Chaves do Supabase](https://supabase.com/docs/guides/getting-started/api-keys) · [URLs de redirecionamento](https://supabase.com/docs/guides/auth/redirect-urls)

## Executar localmente

Com Node.js 24, copie `.env.example` para `.env`, informe as três variáveis do Supabase e execute:

```sh
npm ci
npm start
```

Abra `http://localhost:3000`. Para testar links de e-mail localmente, inclua `http://localhost:3000/?senha=1` na lista de redirecionamento do Supabase.

## Dados da versão anterior

Crie as contas por convite. Em cada perfil do HTML antigo, use **Exportar backup**. Importe esse JSON na conta correspondente da versão online e aguarde a confirmação de sincronização. A importação substitui os registros do perfil de destino. As senhas passam a ser definidas no Supabase Auth.

Os registros da interface são salvos como um documento JSON privado por conta, com revisão para evitar sobrescrita entre dispositivos. O limite é de 8 MiB por perfil, incluindo fotos JPG compactadas. Em caso de conflito de edição, exporte um backup das alterações locais antes de recarregar. A função de apagar dados da interface limpa o perfil, e a exclusão administrativa também remove a conta Auth.
