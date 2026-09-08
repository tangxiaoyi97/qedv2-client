/**
 * Isolated Settings / AI / native-tool browser rehearsal. Start local Vite first.
 * Run with SETTINGS_QA_ORIGIN=http://127.0.0.1:<port> node test/settings-browser-rehearsal.mjs.
 * PLAYWRIGHT_MODULE may point to an existing Playwright module; no credentials,
 * actual storage, Core or Server are used. Every non-local request is blocked.
 * Covers both UI languages at 320 / 390 / 768 / 1440px, with computed assertions
 * and screenshots in /tmp/qed232-settings-*.png.
 */
import { fileURLToPath } from 'node:url';
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
import { assertSettingsGeometry } from './settings-browser-geometry.mjs';
import assert from 'node:assert/strict';

const origin = new URL(process.env.SETTINGS_QA_ORIGIN || 'http://127.0.0.1:18124').origin;
assert(['127.0.0.1', 'localhost', '[::1]'].includes(new URL(origin).hostname), 'Visual rehearsal is local-only');
const compiled = await (await fetch(`${origin}/src/routes/SettingsView.vue`)).text();
const vue = compiled.match(/from "([^"]+\/vue\.js[^\"]*)"/)[1];
const router = compiled.match(/from "([^"]+vue-router\.js[^\"]*)"/)[1];
const ui = compiled.match(/from "([^"]+ui\/src\/index\.ts[^\"]*)"/)[1];
const root = `/@fs${fileURLToPath(new URL('../../', import.meta.url)).replace(/\/$/, '')}`;
const modules = {
  ai: `const ai=reactive({available:true,status:{byo:{configured:true,provider:'openai',model:'gpt-test',last4:'1234'},pool:{eligible:true,remaining:{tokens:1000}},active:'byo',features:{explain:true,assess:true}},statusError:null,capabilities:{providers:['openai','gemini']},mode:'byo',poolOffered:true,byoOffered:true,canTestCredential:true,customInstructions:'',async setMode(mode){ai.mode=mode;},async refreshStatus(){},async saveCredential(){},async deleteCredential(){ai.status.byo.configured=false;},async testCredential(){return {provider:'openai',model:'gpt-test'};},async clearCache(){},async savePromptPreferences(){}});export const useAiStore=()=>ai;`,
  app: `const app=reactive({theme:'light',accentTheme:'violette',config:{aiLanguage:'',coreBaseUrl:'http://127.0.0.1:19222',serverBaseUrl:'http://127.0.0.1:19223'},coreInfo:{version:'1.12.1',bank:{commit:'ff304623607463386026ebeebdbc17a576db1925'}},serverInfo:{version:'2.3.0'},coreRuntimeStatus:{phase:'ready'},coreSourcePreference:'local',coreEndpointSource:'local',async updateConfig(){},async setTheme(value){app.theme=value;},async setAccentTheme(value){app.accentTheme=value;},async refreshServiceInfo(){},async selectCoreSource(value){app.coreSourcePreference=value;app.coreEndpointSource=value;}});export const useAppStore=()=>app;`,
  auth: `export const useAuthStore=()=>reactive({isLoggedIn:true,async logout(){}});`,
  leaderboard: `export const useLeaderboardStore=()=>reactive({loadingProfile:false,profile:{participating:true,nickname:'learner'},async refreshProfile(){},clear(){}});`,
  progress: `export const useProgressStore=()=>reactive({syncStatus:{state:'idle'},attemptUploadStatus:{state:'idle',pendingCount:0},async syncCloudNow(){}});`,
  ui: `import {setUiLocale} from '${ui}';const ui=reactive({locale:new URL(location.href).searchParams.get('locale')||'en',appCommit:'qa',setLocale(value){ui.locale=value;setUiLocale(value);},openAuthModal(){},async showChangelogHistory(){return false;}});export const useUiStore=()=>ui;`,
};
const serviceModule = `export const APP_VERSION='2.3.2';export const attemptOutbox={};export const localProfileStore={currentIfInitialized(){}};export const localRecoveryStore={async inventory(){return {totalCount:0,profiles:[]};}};export const ports={shell:{capabilities:{desktop:true},async openDesktopWindow(){}},coreRuntime:{async selectSource(){},async recover(){}},update:{capabilities:{selfUpdate:true,manualAppInstall:true},async getState(){return {busy:false,targets:['app','core','bank'].map(target=>({target,phase:'complete',currentVersion:target==='app'?'2.3.2':target==='core'?'1.12.1':'ff30462'}))};},onChange(){return ()=>{};},async checkForUpdates(){}}};`;
function html(panel, locale) { return `<!doctype html><html lang="${locale}" data-theme="light" data-accent="violette"><head><meta name="viewport" content="width=device-width, initial-scale=1" /></head><body><div id="app"></div><script type="module">
import { createApp,h } from '${vue}';import {createRouter,createMemoryHistory} from '${router}';import {setUiLocale} from '${ui}';
import '${root}/ui/src/styles/tokens.css';import '${root}/ui/src/styles/themes.css';import '${root}/web/node_modules/@fontsource/public-sans/400.css';import '${root}/web/node_modules/@fontsource/public-sans/600.css';import '${root}/web/node_modules/@fontsource/public-sans/700.css';import '/src/styles/app.css';
import SettingsView from '/src/routes/SettingsView.vue';import DesktopSettings from '/src/routes/settings/DesktopSettings.vue';
setUiLocale('${locale}');const router=createRouter({history:createMemoryHistory(),routes:[{path:'/',component:{render:()=>null}}]});const app=createApp({render:()=>h('main',{class:'qa'},[h(${panel==='settings'?'SettingsView':'DesktopSettings'})])});app.use(router);await router.isReady();app.mount('#app');
</script><style>.qa{max-width:672px;padding:16px;margin:0 auto;}.q-page{padding:0;}</style></body></html>`; }
const browser=await chromium.launch();
const reports=[], errors=[], external=[];
try {
  for(const locale of ['en','de']) for(const width of [320,390,768,1440]) for(const panel of ['settings','desktop']) {
    const context=await browser.newContext({viewport:{width,height:900},deviceScaleFactor:1});
    await context.route('**/*',async route=>{
      const url=new URL(route.request().url());
      if(url.origin!==origin){external.push(url.origin);return route.abort();}
      if(url.pathname==='/__settings-qa')return route.fulfill({contentType:'text/html',body:html(panel,locale)});
      const store=/^\/src\/stores\/(\w+)\.[jt]s$/.exec(url.pathname)?.[1];
      if(store && modules[store])return route.fulfill({contentType:'application/javascript',body:`import {reactive} from '${vue}';${modules[store]}`});
      if(/^\/src\/services\.[jt]s$/.test(url.pathname))return route.fulfill({contentType:'application/javascript',body:serviceModule});
      return route.continue();
    });
    const page=await context.newPage();page.on('pageerror',e=>{errors.push(e.message);console.error(e.message);});
    await page.goto(`${origin}/__settings-qa?panel=${panel}&locale=${locale}`);
    await page.locator(panel==='settings'?'.settings__title':'.desktop-settings__title').waitFor();
    await page.evaluate(()=>document.fonts.ready);
    async function check(state){
      await page.screenshot({path:`/tmp/qed232-settings-${locale}-${width}-${panel}-${state}.png`,fullPage:true});
      try {const report=await assertSettingsGeometry(page);reports.push({locale,width,panel,state,rows:report.rows.length,buttons:report.buttons.length,fields:report.fields.length});}
      catch(error){console.error(`${locale} ${width} ${panel} ${state}`,error);throw error;}
    }
    await check('overview');
    if(panel==='settings'){
      await page.locator('[aria-controls="ai-credential-editor"]').click();
      await check('key');
      await page.locator('[aria-controls="ai-credential-editor"]').click();
      await page.locator('[aria-controls="ai-preferences-editor"]').click();
      await page.locator('[aria-controls="ai-privacy-details"]').click();
      await page.getByRole('button',{name:locale==='en'?'Server addresses':'Serveradressen',exact:true}).click();
      await check('preferences');
    } else {
      await page.getByRole('button',{name:locale==='en'?'Runtime details':'Laufzeitdetails',exact:true}).click();
      await check('runtime');
    }
    await context.close();
  }
  assert.deepEqual(errors,[]);assert.deepEqual(external,[]);
  console.log(JSON.stringify({reports,errors,external},null,2));
}finally{await browser.close();}
