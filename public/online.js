(() => {
  'use strict';

  const $ = id => document.getElementById(id);
  const accessLabels = { male: 'Treino masculino', female: 'Treino feminino', both: 'Ambas as bibliotecas' };
  let client, config, revision = 0, pending, attempted, syncing = false, conflict = false, account;
  const message = text => { $('auth-message').textContent = text; };
  const syncMessage = text => { $('sync-message').textContent = text; };

  window.addEventListener('beforeunload', event => {
    if (!pending && !syncing) return;
    event.preventDefault();
    event.returnValue = '';
  });

  async function sync() {
    if (syncing || conflict || !pending) return;
    syncing = true;
    $('sync-retry').hidden = true;
    syncMessage('Salvando no Supabase…');
    try {
      while (pending) {
        const snapshot = attempted ?? pending;
        attempted = snapshot;
        const { data, error } = await client.rpc('save_fitness_state', {
          expected_user_id: account.id, expected_revision: revision, new_snapshot: snapshot,
        });
        if (error) {
          if (error.code) attempted = undefined;
          throw error;
        }
        if (data === null) {
          const current = await client.from('fitness_state')
            .select('revision, snapshot').eq('user_id', account.id).maybeSingle();
          if (current.error) throw current.error;
          // A resposta anterior pode ter se perdido após a gravação.
          if (!current.data || current.data.revision !== revision + 1 ||
              !sameJson(current.data.snapshot, snapshot)) {
            conflict = true;
            syncMessage('Outro dispositivo alterou os dados. Exporte um backup das suas alterações antes de recarregar.');
            return;
          }
          revision = current.data.revision;
        } else {
          revision = data;
        }
        attempted = undefined;
        if (pending === snapshot) pending = undefined;
      }
      syncMessage('Dados salvos no Supabase.');
    } catch (error) {
      syncMessage(error.code === '23514'
        ? 'O perfil excedeu o limite de armazenamento. Remova fotos ou exporte um backup.'
        : 'Alterações pendentes. Verifique a conexão e tente salvar novamente.');
      $('sync-retry').hidden = false;
    } finally {
      syncing = false;
    }
  }

  function sameJson(left, right) {
    if (left === right) return true;
    if (!left || !right || typeof left !== 'object' || typeof right !== 'object' ||
        Array.isArray(left) !== Array.isArray(right)) return false;
    const keys = Object.keys(left);
    return keys.length === Object.keys(right).length &&
      keys.every(key => Object.hasOwn(right, key) && sameJson(left[key], right[key]));
  }

  function queueSave(snapshot) {
    pending = JSON.parse(JSON.stringify(snapshot));
    void sync();
  }

  async function api(path, options = {}) {
    const { data: { session } } = await client.auth.getSession();
    if (!session || session.user.id !== account?.id) throw new Error('Entre novamente na sua conta.');
    const response = await fetch(path, {
      ...options,
      headers: {
        Authorization: 'Bearer ' + session.access_token,
        ...(options.body ? { 'Content-Type': 'application/json' } : {}),
      },
    });
    const body = await response.json();
    if (!response.ok) throw new Error(body.error);
    return body;
  }

  function action(label, handler) {
    const button = document.createElement('button');
    button.textContent = label;
    button.onclick = async () => {
      button.disabled = true;
      try { await handler(); }
      catch (error) { $('account-message').textContent = error.message; }
      finally { button.disabled = false; }
    };
    return button;
  }

  async function renderUsers(page = 1) {
    const { users, nextPage } = await api('/api/admin/users?page=' + page);
    const rows = users.map(user => {
      const row = document.createElement('div');
      row.className = 'listitem row';
      const details = document.createElement('span');
      details.textContent = [user.name, user.email, accessLabels[user.trainingAccess],
        user.protected ? 'Equipe' : user.confirmed ? '' : 'Convite pendente'].filter(Boolean).join(' · ');
      row.append(details);
      if (!user.protected) {
        const buttons = document.createElement('span');
        buttons.className = 'actions';
        buttons.append(action(user.confirmed ? 'Enviar redefinição' : 'Reenviar convite', async () => {
          await api('/api/admin/users/' + user.id + '/reset', { method: 'POST' });
          $('account-message').textContent = 'E-mail enviado.';
        }), action('Excluir', async () => {
          if (!confirm('Excluir ' + user.email + ' e todos os registros dessa conta?')) return;
          await api('/api/admin/users/' + user.id, { method: 'DELETE' });
          $('account-message').textContent = 'Conta excluída.';
          await renderUsers();
        }));
        row.append(buttons);
      }
      return row;
    });
    if (page > 1) rows.push(action('Página anterior', () => renderUsers(page - 1)));
    if (nextPage > page) rows.push(action('Próxima página', () => renderUsers(nextPage)));
    $('account-list').replaceChildren(...rows);
  }

  async function showApp(session) {
    const [profile, roles, state] = await Promise.all([
      client.from('profiles').select('full_name, training_access').eq('id', session.user.id).single(),
      client.from('user_roles').select('role').eq('user_id', session.user.id).eq('role', 'owner').maybeSingle(),
      client.from('fitness_state').select('revision, snapshot').eq('user_id', session.user.id).maybeSingle(),
    ]);
    if (profile.error || roles.error || state.error) {
      throw new Error('Não foi possível carregar seu perfil. Verifique a conexão e tente novamente.');
    }
    revision = state.data?.revision ?? 0;
    window.startFitnessApp(state.data?.snapshot, profile.data.training_access, queueSave);
    account = session.user;
    $('current-account-name').textContent = profile.data.full_name || account.email;
    $('current-account-role').textContent = roles.data ? 'Administrador Master' : 'Usuário';
    $('login-gate').style.display = 'none';
    $('app-header').style.display = 'block';
    $('app-main').style.display = 'block';
    syncMessage('Dados sincronizados com o Supabase.');
    if (roles.data) {
      $('admin-users').style.display = 'block';
      renderUsers().catch(error => { $('account-message').textContent = error.message; });
    }
  }

  async function login(event) {
    event.preventDefault();
    const button = $('auth-login');
    button.disabled = true;
    message('Entrando…');
    try {
      const { data, error } = await client.auth.signInWithPassword({
        email: $('auth-user').value.trim(), password: $('auth-pass').value,
      });
      if (error) throw new Error(error.status === 400
        ? 'Não foi possível entrar. Confira o e-mail e a senha.' : 'Não foi possível entrar agora.');
      $('auth-pass').value = '';
      await showApp(data.session);
    } catch (error) { message(error.message); }
    finally { button.disabled = false; }
  }

  async function changePassword(event) {
    event.preventDefault();
    const form = $('password-form');
    const button = form.querySelector('button[type="submit"]');
    const password = $('new-password').value;
    button.disabled = true;
    try {
      if (account) {
        const { error } = await client.auth.signInWithPassword({
          email: account.email, password: $('current-password').value,
        });
        if (error) throw new Error('Não foi possível confirmar a senha atual.');
      }
      const { error } = await client.auth.updateUser({ password });
      if (error) throw new Error('Use uma senha nova com pelo menos 10 caracteres. Se o link expirou, solicite outro.');
      form.reset();
      if (!account) {
        history.replaceState(null, '', '/');
        location.reload();
      } else {
        form.parentElement.close();
        syncMessage('Senha atualizada.');
      }
    } catch (error) { $('password-message').textContent = error.message; }
    finally { button.disabled = false; }
  }

  async function start() {
    const params = new URLSearchParams(location.search);
    const fragment = new URLSearchParams(location.hash.slice(1));
    const linkError = params.has('error') || fragment.has('error');
    const passwordLink = params.get('senha') === '1';
    const response = await fetch('/api/config');
    if (!response.ok) throw new Error('Configuração online indisponível.');
    config = await response.json();
    client = window.supabase.createClient(config.url, config.key);
    client.auth.onAuthStateChange((event, session) => {
      if (!account || session?.user.id === account.id) return;
      $('app-main').style.display = 'none';
      if (pending || syncing) {
        $('app-main').style.display = 'block';
        syncMessage('A sessão mudou. Exporte um backup das alterações e entre novamente.');
        return;
      }
      setTimeout(() => location.replace('/'), 0);
    });
    $('auth-form').addEventListener('submit', login);
    $('auth-recover').onclick = async () => {
      const email = $('auth-user').value.trim();
      if (!email || !$('auth-user').checkValidity()) return message('Informe seu e-mail para recuperar a senha.');
      try {
        const { error } = await client.auth.resetPasswordForEmail(email, { redirectTo: config.redirectTo });
        if (error && error.status !== 400) throw error;
        message('Se houver uma conta para esse e-mail, você receberá um link de recuperação.');
      } catch { message('Não foi possível enviar o link agora. Tente novamente.'); }
    };
    $('sync-retry').onclick = sync;
    window.addEventListener('online', sync);
    $('logout').onclick = async () => {
      if ((pending || syncing) && !confirm('Há alterações sem confirmação no Supabase. Sair mesmo assim?')) return;
      const { error } = await client.auth.signOut({ scope: 'local' });
      if (error) return syncMessage('Não foi possível sair. Tente novamente.');
      pending = undefined;
      syncing = false;
      location.replace('/');
    };
    $('change-password').onclick = () => {
      $('password-message').textContent = '';
      $('password-dialog').showModal();
    };
    $('password-form').addEventListener('submit', changePassword);
    $('password-cancel').onclick = () => $('password-dialog').close();
    $('invite-form').addEventListener('submit', async event => {
      event.preventDefault();
      const button = $('create-account');
      button.disabled = true;
      try {
        await api('/api/admin/users', { method: 'POST', body: JSON.stringify({
          email: $('new-account-email').value.trim(),
          name: $('new-account-name').value.trim(),
          trainingAccess: $('new-account-access').value,
        }) });
        event.target.reset();
        $('account-message').textContent = 'Convite enviado.';
        await renderUsers();
      } catch (error) { $('account-message').textContent = error.message; }
      finally { button.disabled = false; }
    });

    const { data: { session } } = await client.auth.getSession();
    if (passwordLink && fragment.has('access_token') && session &&
        session.access_token === fragment.get('access_token') && !linkError) {
      const form = $('password-form');
      $('login-gate').append(form);
      $('auth-form').hidden = true;
      $('current-password').required = false;
      $('password-current-field').hidden = true;
      $('password-cancel').hidden = true;
      message('Defina uma senha para acessar sua conta.');
    } else if (passwordLink || linkError) {
      history.replaceState(null, '', '/');
      message('Link inválido ou expirado. Solicite um novo link ou entre com sua senha.');
    } else if (session) {
      await showApp(session);
    }
  }

  start().catch(error => message(error.message || 'Não foi possível iniciar o Fitness Pro.'));
})();
