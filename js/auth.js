// Supabase client + auth screen (sign in, sign up, magic link, reset, confirm-email state).
import { SUPABASE_ANON_KEY, SUPABASE_URL } from './config.js';
import { SUPABASE_JS_URL } from './vendor.js';
import { $ } from './util.js';

export const isConfigured = () => Boolean(SUPABASE_URL && SUPABASE_ANON_KEY);

/** Where Supabase should send users back to (works on localhost and on /notes-app/). */
export const redirectUrl = () => window.location.origin + window.location.pathname;

let clientPromise = null;

/**
 * Create the client once. `onEvent` is registered synchronously right after
 * createClient so it also receives events emitted during initialisation
 * (INITIAL_SESSION, SIGNED_IN / PASSWORD_RECOVERY from an email link).
 */
export function initSupabase(onEvent) {
  if (!clientPromise) {
    clientPromise = import(SUPABASE_JS_URL).then(({ createClient }) => {
      const client = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
        auth: {
          persistSession: true,
          autoRefreshToken: true,
          detectSessionInUrl: true,
          flowType: 'implicit', // links work even if opened in a different browser
          storageKey: 'notes-app-auth',
        },
      });
      client.auth.onAuthStateChange((event, session) => {
        // Never await Supabase calls inside this callback (it can deadlock the
        // auth lock); hand off to the next macrotask instead.
        setTimeout(() => onEvent(event, session), 0);
      });
      return client;
    }).catch((err) => {
      clientPromise = null;
      throw err;
    });
  }
  return clientPromise;
}

/** Inspect the URL for an auth callback before supabase-js consumes it. */
export function readAuthRedirect() {
  const hash = new URLSearchParams(window.location.hash.replace(/^#/, ''));
  const query = new URLSearchParams(window.location.search);
  const get = (k) => hash.get(k) ?? query.get(k);
  const error = get('error_description') || get('error');
  return {
    present: Boolean(hash.get('access_token') || query.get('code') || error),
    type: get('type'),
    error: error ? error.replace(/\+/g, ' ') : null,
    errorCode: get('error_code'),
  };
}

/** Remove auth tokens / errors / an empty "#" from the address bar. */
export function cleanAuthUrl() {
  const url = new URL(window.location.href);
  let dirty = url.hash === '#' || /access_token|error|type=/.test(url.hash) || window.location.href.endsWith('#');
  for (const k of ['code', 'error', 'error_code', 'error_description']) {
    if (url.searchParams.has(k)) { url.searchParams.delete(k); dirty = true; }
  }
  if (dirty) {
    url.hash = '';
    history.replaceState(history.state, '', url.pathname + url.search);
  }
}

function friendly(err) {
  const msg = err?.message || String(err || 'Something went wrong');
  if (/invalid login credentials/i.test(msg)) return 'That email and password don’t match.';
  if (/rate limit|only request this after|too many/i.test(msg)) return 'Too many attempts — please wait a minute and try again.';
  if (/failed to fetch|network/i.test(msg)) return 'Can’t reach the server. Check your connection.';
  if (/password should be at least/i.test(msg)) return 'Password must be at least 6 characters.';
  return msg;
}

/**
 * Wire up the auth screen.
 * @param {{ getClient: () => Promise<any>, onDemo: () => void }} deps
 */
export function mountAuthView({ getClient, onDemo }) {
  const view = $('#auth-view');
  const forms = $('#auth-forms');
  const check = $('#auth-check');
  const checkText = $('#auth-check-text');
  const msg = $('#auth-msg');
  const tabs = { signin: $('#tab-signin'), signup: $('#tab-signup') };
  const panels = { signin: $('#form-signin'), signup: $('#form-signup') };
  let lastResend = null; // () => Promise

  const say = (text, kind = 'info') => {
    msg.textContent = text || '';
    msg.dataset.kind = kind;
  };

  function selectTab(name, focus = false) {
    for (const k of Object.keys(tabs)) {
      const on = k === name;
      tabs[k].setAttribute('aria-selected', String(on));
      tabs[k].tabIndex = on ? 0 : -1;
      panels[k].hidden = !on;
    }
    if (focus) tabs[name].focus();
    say('');
  }
  tabs.signin.addEventListener('click', () => selectTab('signin'));
  tabs.signup.addEventListener('click', () => selectTab('signup'));
  for (const t of Object.values(tabs)) {
    t.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
        e.preventDefault();
        selectTab(t === tabs.signin ? 'signup' : 'signin', true);
      }
    });
  }

  function showCheck(text, resend) {
    lastResend = resend;
    checkText.textContent = text;
    $('#auth-resend').hidden = !resend;
    forms.hidden = true;
    check.hidden = false;
    say('');
    check.focus();
  }
  function hideCheck() {
    check.hidden = true;
    forms.hidden = false;
  }
  $('#auth-back').addEventListener('click', () => { hideCheck(); panels.signin.querySelector('input').focus(); });
  $('#auth-resend').addEventListener('click', async (e) => {
    if (!lastResend) return;
    await busy(e.currentTarget, async () => {
      const { error } = await lastResend();
      if (error) say(friendly(error), 'error');
      else say('Sent again. It can take a minute to arrive.', 'success');
    });
  });

  async function busy(button, fn) {
    const buttons = view.querySelectorAll('button');
    buttons.forEach((b) => { b.disabled = true; });
    button?.setAttribute('aria-busy', 'true');
    try {
      await fn();
    } catch (err) {
      say(friendly(err), 'error');
    } finally {
      buttons.forEach((b) => { b.disabled = false; });
      button?.removeAttribute('aria-busy');
    }
  }

  function readEmail(input) {
    const email = input.value.trim();
    if (!email || !input.checkValidity()) {
      say('Enter a valid email address.', 'error');
      input.focus();
      return null;
    }
    return email;
  }

  const resendSignup = (email) => async () => (await getClient()).auth.resend({
    type: 'signup', email, options: { emailRedirectTo: redirectUrl() },
  });

  // Sign in with password
  panels.signin.addEventListener('submit', (e) => {
    e.preventDefault();
    const email = readEmail($('#signin-email'));
    if (!email) return;
    const pw = $('#signin-password');
    if (!pw.value) { say('Enter your password.', 'error'); pw.focus(); return; }
    busy(e.submitter, async () => {
      say('Signing in…');
      const client = await getClient();
      const { error } = await client.auth.signInWithPassword({ email, password: pw.value });
      if (error) {
        if (/email not confirmed/i.test(error.message)) {
          showCheck(`Confirm your email first — we sent a link to ${email}.`, resendSignup(email));
        } else {
          say(friendly(error), 'error');
        }
        return;
      }
      pw.value = '';
      say('');
      // onAuthStateChange(SIGNED_IN) switches the app to cloud mode.
    });
  });

  // Magic link
  $('#magic-btn').addEventListener('click', (e) => {
    const email = readEmail($('#signin-email'));
    if (!email) return;
    busy(e.currentTarget, async () => {
      const client = await getClient();
      const send = () => client.auth.signInWithOtp({
        email, options: { emailRedirectTo: redirectUrl(), shouldCreateUser: true },
      });
      const { error } = await send();
      if (error) { say(friendly(error), 'error'); return; }
      showCheck(`We emailed a sign-in link to ${email}. Open it on this device to continue.`, send);
    });
  });

  // Password reset request
  $('#forgot-btn').addEventListener('click', (e) => {
    const email = readEmail($('#signin-email'));
    if (!email) { say('Enter your email above, then choose “Forgot password?”.', 'error'); return; }
    busy(e.currentTarget, async () => {
      const client = await getClient();
      const send = () => client.auth.resetPasswordForEmail(email, { redirectTo: redirectUrl() });
      const { error } = await send();
      if (error) { say(friendly(error), 'error'); return; }
      showCheck(`If ${email} has an account, a password reset link is on its way.`, send);
    });
  });

  // Sign up
  panels.signup.addEventListener('submit', (e) => {
    e.preventDefault();
    const email = readEmail($('#signup-email'));
    if (!email) return;
    const pw = $('#signup-password');
    if (pw.value.length < 6) { say('Password must be at least 6 characters.', 'error'); pw.focus(); return; }
    busy(e.submitter, async () => {
      say('Creating your account…');
      const client = await getClient();
      const { data, error } = await client.auth.signUp({
        email, password: pw.value, options: { emailRedirectTo: redirectUrl() },
      });
      if (error) { say(friendly(error), 'error'); return; }
      pw.value = '';
      if (data.session) { say(''); return; } // email confirmation disabled → signed in
      if (data.user && Array.isArray(data.user.identities) && data.user.identities.length === 0) {
        // Supabase obfuscates existing accounts: no identities means already registered.
        selectTab('signin');
        $('#signin-email').value = email;
        say('That email already has an account — sign in instead (or reset your password).', 'error');
        return;
      }
      showCheck(`Almost there — we sent a confirmation link to ${email}. Open it to activate your account.`, resendSignup(email));
    });
  });

  $('#demo-btn').addEventListener('click', onDemo);

  return {
    show(message, kind) {
      hideCheck();
      view.hidden = false;
      if (message) say(message, kind); else say('');
      requestAnimationFrame(() => $('#signin-email').focus());
    },
    hide() { view.hidden = true; },
    say,
  };
}

/** Wire the "choose a new password" dialog shown after a recovery link. */
export function mountPasswordDialog({ getClient, toast }) {
  const dialog = $('#password-dialog');
  const form = $('#password-form');
  const input = $('#new-password');
  const msg = $('#password-msg');
  $('#password-cancel').addEventListener('click', () => dialog.close());
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (input.value.length < 6) { msg.textContent = 'Password must be at least 6 characters.'; input.focus(); return; }
    const submit = form.querySelector('[type=submit]');
    submit.disabled = true;
    try {
      const client = await getClient();
      const { error } = await client.auth.updateUser({ password: input.value });
      if (error) { msg.textContent = friendly(error); return; }
      input.value = '';
      dialog.close();
      toast('Password updated.', { type: 'success' });
    } catch (err) {
      msg.textContent = friendly(err);
    } finally {
      submit.disabled = false;
    }
  });
  return {
    open() {
      msg.textContent = '';
      if (!dialog.open) dialog.showModal();
      input.focus();
    },
  };
}
