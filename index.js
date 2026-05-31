const express = require('express');
const cors = require('cors');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json({ limit: '50mb' }));

// ── Complexity scorer ──────────────────────────────────────────────────────
function scoreComplexity(prompt) {
  let score = 0;
  const p = prompt.toLowerCase();

  if (/medications?:\s*(?!none)/i.test(prompt) && !/medications?:\s*none/i.test(prompt)) score += 2;
  if (/lab data:/i.test(prompt) && !/no labs provided/i.test(prompt)) score += 2;
  if (/diagnoses?:\s*(?!none)/i.test(prompt) && !/diagnoses?:\s*none/i.test(prompt)) score += 2;

  const ageMatch = prompt.match(/age:\s*(\d+)/i);
  if (ageMatch && parseInt(ageMatch[1]) >= 40) score += 1;

  const severeMatches = (prompt.match(/:\s*severe/gi) || []).length;
  score += Math.min(severeMatches, 4);

  if (/hashimoto|hypothyroid|perimenopause|postmenopause|pcos|irregular cycles/i.test(p)) score += 1;
  if (/autoimmune|lupus|rheumatoid|crohn|celiac|multiple sclerosis/i.test(p)) score += 1;

  let systems = 0;
  if (/bloating|constipation|bowel|ibs|gut/i.test(p)) systems++;
  if (/thyroid|tsh|hashimoto/i.test(p)) systems++;
  if (/anxiety|depression|mood|burnout/i.test(p)) systems++;
  if (/fatigue|exhaustion|crashes/i.test(p)) systems++;
  if (/insulin|blood sugar|hba1c|prediabetes/i.test(p)) systems++;
  if (/hormone|estrogen|progesterone|perimenopause/i.test(p)) systems++;
  if (systems >= 3) score += 1;

  if (score <= 3) return 'SIMPLE';
  if (score <= 6) return 'MODERATE';
  return 'COMPLEX';
}

// ── Anthropic caller ───────────────────────────────────────────────────────
async function callClaude(apiKey, messages, maxTokens) {
  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4-6',
      max_tokens: maxTokens,
      messages,
    }),
  });
  const data = await response.json();
  if (data.error) throw new Error(data.error.type + ': ' + data.error.message);
  return data.content?.map(b => b.text || '').join('') || '';
}

// ── Non-streaming proxy (lab extraction + 2-stage report) ──────────────────
app.post('/generate-report', async (req, res) => {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return res.status(500).json({ error: { type: 'configuration_error', message: 'API key not configured.' } });
  }

  try {
    const incomingMessages = req.body.messages;
    const firstContent = incomingMessages?.[0]?.content;

    // Lab image extraction calls — forward directly
    if (Array.isArray(firstContent)) {
      const response = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify(req.body),
      });
      const data = await response.json();
      return res.status(response.status).json(data);
    }

    const fullPrompt = firstContent;
    if (!fullPrompt || typeof fullPrompt !== 'string') {
      return res.status(400).json({ error: { type: 'bad_request', message: 'No prompt received.' } });
    }

    const tier = scoreComplexity(fullPrompt);
    console.log('[Rootiva] Complexity tier:', tier);

    // STAGE 1: Clinical plan
    const stage1Prompt = `You are a functional wellness clinical analyst. Read this client intake carefully and produce a precise clinical plan. Think like an experienced integrative practitioner.

COMPLEXITY TIER FOR THIS CLIENT: ${tier}

${tier === 'SIMPLE' ? `This is a SIMPLE case.
- Maximum 2 modules may fully trigger
- Maximum 3 supplements total
- Lifestyle must dominate over supplements
- Focus on the client primary goal above all else` : ''}
${tier === 'MODERATE' ? `This is a MODERATE case.
- Maximum 4 modules may fully trigger
- Maximum 5 supplements total
- Balance lifestyle guidance with targeted functional education` : ''}
${tier === 'COMPLEX' ? `This is a COMPLEX case. Full premium Rootiva depth is appropriate.
- All justified modules may fully trigger
- Maximum 8 supplements total
- Full cross-system reasoning` : ''}

OUTPUT THESE SECTIONS:

1. SAFETY CHECK
Active cancer treatment, hospitalization, suicidal ideation, psychiatric crisis?
If any: write STOP — [reason]. If none: write CLEAR

2. PRIMARY GOAL
State the client single most important goal.

3. SIGNIFICANT FINDINGS
List only genuinely significant findings with actual numbers.
${tier === 'SIMPLE' ? 'Maximum 4 findings.' : ''}

4. MODULE SELECTION
Gut FULL trigger: 2+ of: bloating moderate/severe, bowel <daily, food sensitivities moderate/severe, antibiotic history, IBS, undigested food
Thyroid FULL trigger: 2+ of: thyroid diagnosis, TSH outside optimal, Free T3/T4 outside optimal, thyroid medication, 4+ thyroid symptoms
Blood sugar FULL trigger: 2+ of: fasting insulin >6, HbA1c >5.4%, sweet cravings severe, energy crashes, weight gain, prediabetes
HPA axis FULL trigger: ALL THREE: stress high/very high AND sleep poor AND fatigue present
Hormonal: female only, 2+ of: age 38+, irregular cycles, PMS moderate/severe, hot flashes, low libido, perimenopause
Immune FULL trigger: 2+ of: frequent infections, autoimmune diagnosis, elevated hsCRP, joint pain moderate/severe
Mood FULL trigger: moderate/severe depression, anxiety, or mood swings
Chronic fatigue: fatigue 3+ months post-viral OR 6+ months unexplained OR PEM OR statin use

For each module: TRIGGERED / MENTION ONLY / NOT TRIGGERED plus evidence and profile A/B/C/D/E

5. SUPPLEMENT PLAN
${tier === 'SIMPLE' ? 'Maximum 3 supplements.' : tier === 'MODERATE' ? 'Maximum 5 supplements.' : 'Maximum 8 supplements.'}
Chromium cross-check: fasting insulin >6 OR sweet cravings severe.
CoQ10 cross-check: any statin.
Never include: St Johns Wort, high dose iodine, phenibut, high dose B6.

6. KEY CONNECTIONS
2-4 specific connections between findings using actual client data.

7. LIFESTYLE PRIORITIES
${tier === 'SIMPLE' ? '3-5 lifestyle interventions. Lifestyle is the main intervention.' : '3-5 most impactful lifestyle interventions.'}

8. DIET PRIORITIES
Maximum 3 dietary considerations. Trial language only.

9. SUGGESTED LABS
${tier === 'SIMPLE' ? 'Maximum 3.' : tier === 'MODERATE' ? 'Maximum 5.' : 'Maximum 8.'}

10. CLINICIAN FLAGS
Genuine red flags requiring medical attention only.

CLIENT INTAKE:
${fullPrompt}`;

    const stage1Result = await callClaude(apiKey, [{ role: 'user', content: stage1Prompt }], 2000);

    // Safety gate
    const upper = stage1Result.toUpperCase();
    if (upper.includes('STOP \u2014') || upper.includes('STOP -')) {
      if (upper.includes('SUICID') || upper.includes('PSYCHIATRIC CRISIS')) {
        return res.status(200).json({
          content: [{ type: 'text', text: 'Thank you for reaching out. Rootiva is not equipped to support someone currently experiencing a mental health crisis. Please contact your mental health provider or call a crisis line. Crisis Text Line: Text HOME to 741741.' }]
        });
      }
      return res.status(200).json({
        content: [{ type: 'text', text: 'Thank you for completing the Rootiva intake. Based on your responses, Rootiva is not the appropriate resource for your current situation. Please connect with your healthcare provider or specialist team who can best support you right now.' }]
      });
    }

    const tierWritingInstructions = {
      SIMPLE: `REPORT DEPTH: SIMPLE
- Keep sections concise. No lengthy physiology explanations.
- Lifestyle section is the most important and detailed section.
- Maximum 3 supplements total.
- Tone: encouraging, realistic, grounded, warm.
- Length: approximately 3-4 pages.`,
      MODERATE: `REPORT DEPTH: MODERATE
- Maximum 5 supplements total.
- Balance lifestyle guidance with functional education.
- Tone: intelligent, warm, clinically grounded.
- Length: approximately 5-7 pages.`,
      COMPLEX: `REPORT DEPTH: COMPLEX
- Maximum 8 supplements total.
- Full cross-system reasoning.
- Tone: premium, intelligent, deeply personalized, emotionally supportive.
- Length: comprehensive.`
    };

    // STAGE 2: Full report
    const stage2Prompt = `You are Rootiva's functional wellness education AI. Write a complete personalized wellness education report.

You are NOT a medical doctor. You ARE a functional wellness educator providing educational information only.

${tierWritingInstructions[tier]}

Use the clinical plan below as your foundation. Follow module selections exactly.
Do NOT add modules not listed as TRIGGERED. Do NOT expand MENTION ONLY into full sections.

CLINICAL PLAN:
${stage1Result}

MODULE FRAMEWORKS:

GUT: 5R framework — Remove, Replace, Reinoculate, Repair, Rebalance. Connect gut to broader symptom picture.
THYROID: Metabolic pacemaker education. Levothyroxine timing ALWAYS when on medication. Iodine caution always.
HPA AXIS: NEVER adrenal fatigue. ALWAYS HPA axis dysregulation, cortisol rhythm disruption. Circadian rhythm first.
BLOOD SUGAR: Meal composition first. Protein at every meal. Movement after meals.
HORMONAL: HRT always balanced. Estrogen dominance: liver and gut clearance. Post-menopause: bone health mandatory.
WEIGHT MANAGEMENT: Protein 1.6-2g per kg. Blood sugar stability. Protein-forward breakfast. Strength training plus daily movement. Sleep as metabolic regulator.

BANNED LANGUAGE:
Critically low / You have [condition] / Burned out adrenals / Heal your gut / Rewire your nervous system / Push through the fatigue / Immune boosting / You have depression / You have anxiety

FORMATTING:
## major headings / ### sub-headings / #### supplement tier labels
**Supplement Name** — Dose — Rationale — Safety note
Bullet points with -. No tables.

SUPPLEMENT TIERS:
Tier 1 opening: "The following are educational wellness considerations only. Please discuss with your healthcare provider before beginning any new supplement."
Tier 2 opening: "The following are presented as educational awareness items only. Individual suitability must be reviewed by a qualified healthcare provider."
Never duplicate supplements across modules.

REPORT STRUCTURE — exact order:

## Educational Disclaimer
This report is created for educational and wellness purposes only. It does not constitute medical advice, diagnosis, or treatment.

## Patient Snapshot
## What We Found
## Why You Feel This Way
[Triggered module sections only]
## Nutrition Highlights
## Lifestyle Priorities
## When to See Your Healthcare Provider
## Suggested Labs
## Your 90-Day Wellness Roadmap
## Continue Your Wellness Journey
"[Client name], your wellness picture is not static. As your labs change and symptoms shift, Rootiva can provide updated educational insights."

## Educational Disclaimer
This report is created for educational and wellness purposes only. It does not constitute medical advice, diagnosis, or treatment.

Write the complete report now. Warm, clinically thoughtful, genuinely personalized.`;

    const maxTokens = tier === 'SIMPLE' ? 3000 : tier === 'MODERATE' ? 4500 : 6000;
    const stage2Result = await callClaude(apiKey, [{ role: 'user', content: stage2Prompt }], maxTokens);

    return res.status(200).json({
      content: [{ type: 'text', text: stage2Result }]
    });

  } catch (err) {
    console.error('[Rootiva] Generation error:', err.message);
    return res.status(502).json({ error: { type: 'generation_error', message: err.message } });
  }
});

// ── SSE streaming proxy (report generation) ───────────────────────────────────

app.post('/generate-report-stream', async (req, res) => {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    res.status(500).json({ error: { type: 'configuration_error', message: 'API key not configured.' } });
    return;
  }

  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  res.setHeader('Transfer-Encoding', 'chunked');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();

  const send = (obj) => {
    res.write('data: ' + JSON.stringify(obj) + '\n\n');
    if (typeof res.flush === 'function') res.flush();
  };

  let anthropicResponse;
  try {
    anthropicResponse = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({ ...req.body, stream: true }),
    });
  } catch (err) {
    send({ type: 'error', message: 'Failed to reach Anthropic API: ' + err.message });
    res.end();
    return;
  }

  if (!anthropicResponse.ok) {
    let errBody = '';
    try { errBody = await anthropicResponse.text(); } catch (_) {}
    let errMessage = 'Anthropic API error ' + anthropicResponse.status;
    try {
      const parsed = JSON.parse(errBody);
      errMessage = parsed && parsed.error && parsed.error.message ? parsed.error.message : errMessage;
    } catch (_) {}
    send({ type: 'error', message: errMessage });
    res.end();
    return;
  }

  const responseBody = anthropicResponse.body;
  let lineBuffer = '';

  responseBody.on('data', (chunk) => {
    lineBuffer += chunk.toString('utf-8');
    const lines = lineBuffer.split('\n');
    lineBuffer = lines.pop();

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('event:') || !trimmed.startsWith('data:')) continue;

      const jsonStr = trimmed.slice(5).trim();
      if (jsonStr === '[DONE]') { send({ done: true }); continue; }

      let evt;
      try { evt = JSON.parse(jsonStr); } catch (_) { continue; }

      switch (evt.type) {
        case 'content_block_delta':
          if (evt.delta && evt.delta.type === 'text_delta' && evt.delta.text) {
            send({ text: evt.delta.text });
          }
          break;
        case 'message_delta':
          if (evt.delta && evt.delta.stop_reason) {
            send({ stop_reason: evt.delta.stop_reason });
          }
          break;
        case 'message_stop':
          send({ done: true });
          break;
        case 'error':
          send({ type: 'error', message: (evt.error && evt.error.message) || 'Anthropic stream error' });
          break;
        default:
          break;
      }
    }
  });

  responseBody.on('error', (err) => {
    send({ type: 'error', message: 'Stream read error: ' + err.message });
    res.end();
  });

  responseBody.on('end', () => {
    send({ done: true });
    res.end();
  });

  req.on('close', () => {
    try { responseBody.destroy(); } catch (_) {}
  });
});

// ── Health check ──────────────────────────────────────────────────────────────

app.get('/health', (req, res) => {
  res.json({ status: 'ok' });
});

app.listen(PORT, () => {
  console.log('[Rootiva] Server running on port ' + PORT);
});
