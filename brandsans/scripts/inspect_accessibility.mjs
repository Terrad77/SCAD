import {createRequire} from 'node:module';
const require=createRequire(new URL('../demo/package.json',import.meta.url));
const {chromium}=require('playwright');const {default:AxeBuilder}=require('@axe-core/playwright');
const browser=await chromium.launch({headless:true,channel:'msedge'});
try{const context=await browser.newContext();const page=await context.newPage();await page.goto('http://127.0.0.1:4173/');await page.getByText('Both local webfonts loaded.').waitFor();const scan=await new AxeBuilder({page}).withTags(['wcag2a','wcag2aa','wcag21aa','wcag22aa']).analyze();console.log(JSON.stringify(scan.incomplete.map(i=>({id:i.id,nodes:i.nodes.map(n=>({target:n.target,html:n.html,summary:n.failureSummary}))})),null,2));}finally{await browser.close()}
