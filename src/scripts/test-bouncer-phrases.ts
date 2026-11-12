import dotenv from 'dotenv';
dotenv.config();
import { GeminiBouncerClassifier } from '../core/eligibility/gemini-bouncer.js';

async function test() {
  const b = new GeminiBouncerClassifier();
  const r1 = await b.classify('we still on for tonight?', 'plumber');
  console.log('r1 ("we still on for tonight?"):', r1);
  const r2 = await b.classify('its tony', 'plumber');
  console.log('r2 ("its tony"):', r2);
}
test();
