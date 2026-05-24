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

  // Medications
  if (/medications?:\s*(?!none)/i.test(prompt) && !/medications?:\s*none/i.test(prompt)) score += 2;

  // Labs uploaded
  if (/lab data:/i.test(prompt) && !/no labs provided/i.test(prompt)) score += 2;

  // Chronic diagnoses
  if (/diagnoses?:\s*(?!none)/i.test(prompt) && !/diagnoses?:\s*none/i.test(prompt)) score += 2;

  // Age over 40
  const ageMatch = prompt.match(/age:\s*(\d+)/i);
  if (ageMatch && parseInt(ageMatch[1]) >= 40) score += 1;

  // Severe symptoms (each one counts)
  const severeMatches = (prompt.match(/:\s*severe/gi) || []).length;
  score += Math.min(severeMatches, 4);

  // Hormonal complexity
  if (/hashimoto|hypothyroid|perimenopause|postmenopause|pcos|irregular cycles/i.test(p)) score += 1;

  // Autoimmune
  if (/autoimmune|lupus|rheumatoid|crohn|celiac|multiple sclerosis/i.test(p)) score += 1;

  // Multiple systems (gut + thyroid + mood etc)
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

// ── Main route ─────────────────────────────────────────────────────────────
app.post('/generate-report', async (req, res) => {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return res.status(500).json({ error: { type: 'configuration_error', message: 'API key not configured.' } });
  }

  try {
    const incomingMessages = req.body.messages;

    // Lab image extraction calls pass image content arrays — forward directly
    const firstContent = incomingMessages?.[0]?.content;
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

    // Main report generation — text prompt
    const fullPrompt = firstContent;
    if (!fullPrompt || typeof fullPrompt !== 'string') {
      return res.status(400).json({ error: { type: 'bad_request', message: 'No prompt received.' } });
    }

    // ── Score complexity ─────────────────────────────────────────────────
    const tier = scoreComplexity(fullPrompt);
    console.log('[Rootiva] Complexity tier:', tier);

    // ── STAGE 1: Clinical plan ───────────────────────────────────────────
    const stage1Prompt = `You are a functional wellness clinical analyst. Read this client intake carefully and produce a precise clinical plan. Think like an experienced integrative practitioner — exercise genuine judgment and restraint.

COMPLEXITY TIER FOR THIS CLIENT: ${tier}

${tier === 'SIMPLE' ? `This is a SIMPLE case. The client likely has straightforward wellness needs.
- Maximum 2 modules may fully trigger
- Maximum 3 supplements total
- Lifestyle must dominate over supplements
- Do not expand into deep endocrine or HPA axis theory unless strongly justified by multiple data points
- Focus on the client's primary goal above all else` : ''}

${tier === 'MODERATE' ? `This is a MODERATE case. Select modules carefully based on corroborating evidence.
- Maximum 4 modules may fully trigger
- Maximum 5 supplements total
- Balance lifestyle guidance with targeted functional education` : ''}

${tier === 'COMPLEX' ? `This is a COMPLEX case. Full premium Rootiva depth is appropriate and warranted.
- All justified modules may fully trigger
- Maximum 8 supplements total
- Full cross-system reasoning
- Comprehensive narrative` : ''}

OUTPUT THESE SECTIONS:

1. SAFETY CHECK
Active cancer treatment, hospitalization, suicidal ideation, psychiatric crisis?
If any: write STOP — [reason]
If none: write CLEAR

2. PRIMARY GOAL
State the client's single most important goal. This anchors everything.
What functional patterns most directly serve this goal?

3. SIGNIFICANT FINDINGS
List only genuinely significant findings with actual numbers.
${tier === 'SIMPLE' ? 'Maximum 4 findings. Be selective — not every symptom is a finding.' : ''}
${tier === 'COMPLEX' ? 'List all clinically meaningful findings.' : ''}

4. MODULE SELECTION
Apply these corroboration rules strictly:

Gut module FULL trigger: 2+ of: bloating moderate/severe, bowel frequency <daily, food sensitivities moderate/severe, antibiotic history, IBS diagnosis, undigested food
Thyroid module FULL trigger: 2+ of: thyroid diagnosis, TSH outside optimal, Free T3/T4 outside optimal, thyroid medication, 4+ thyroid symptom cluster
Blood sugar module FULL trigger: 2+ of: fasting insulin >6, HbA1c >5.4%, sweet cravings severe, energy crashes, weight gain, prediabetes
HPA axis FULL trigger: ALL THREE required: stress high/very high AND sleep poor AND fatigue present. Mild stress alone = brief mention only, not a full module
Hormonal module: female only, 2+ of: age 38+, irregular cycles, PMS moderate/severe, hot flashes, low libido, perimenopause confirmed
Immune module FULL trigger: 2+ of: frequent infections, autoimmune diagnosis, elevated hsCRP, joint pain moderate/severe
Mood module FULL trigger: moderate/severe depression, anxiety, or mood swings — mild stress alone does NOT trigger
Chronic fatigue module: fatigue 3+ months post-viral OR 6+ months unexplained OR PEM OR statin use

For each module: TRIGGERED / MENTION ONLY / NOT TRIGGERED — plus evidence and profile (A/B/C/D/E)

5. SUPPLEMENT PLAN
${tier === 'SIMPLE' ? 'Maximum 3 supplements. List lifestyle recommendations before any supplement.' : ''}
${tier === 'MODERATE' ? 'Maximum 5 supplements.' : ''}
${tier === 'COMPLEX' ? 'Maximum 8 supplements.' : ''}
Apply chromium cross-check: fasting insulin >6 OR sweet cravings severe → add chromium.
Apply CoQ10 cross-check: any statin → always include CoQ10.
Never include: St John's Wort, high dose iodine, phenibut, high dose B6.
List each supplement with dose, rationale, and any drug interaction flag.

6. KEY CONNECTIONS
2-4 specific connections between findings that explain why this client feels the way they do.
Use actual client data.

7. LIFESTYLE PRIORITIES
${tier === 'SIMPLE' ? '3-5 lifestyle interventions. For weight goals: protein, satiety, meal timing, movement, sleep, blood sugar stability must be here. Lifestyle is the main intervention for simple cases.' : '3-5 most impactful lifestyle interventions for this client.'}

8. DIET PRIORITIES
Maximum 3 dietary considerations. Trial language only. No fear framing.

9. SUGGESTED LABS
${tier === 'SIMPLE' ? 'Maximum 3 lab suggestions.' : tier === 'MODERATE' ? 'Maximum 5 lab suggestions.' : 'Maximum 8 lab suggestions.'}

10. CLINICIAN FLAGS
Genuine red flags requiring medical attention only.

CLIENT INTAKE:
${fullPrompt}`;

    const stage1Result = await callClaude(apiKey, [{ role: 'user', content: stage1Prompt }], 2000);

    // ── Safety gate ──────────────────────────────────────────────────────
    const upper = stage1Result.toUpperCase();
    if (upper.includes('STOP —') || upper.includes('STOP —')) {
      if (upper.includes('SUICID') || upper.includes('PSYCHIATRIC CRISIS')) {
        return res.status(200).json({
          content: [{ type: 'text', text: 'Thank you for reaching out. Rootiva is not equipped to support someone currently experiencing a mental health crisis. Please contact your mental health provider or call a crisis line. Crisis Text Line: Text HOME to 741741.' }]
        });
      }
      return res.status(200).json({
        content: [{ type: 'text', text: 'Thank you for completing the Rootiva intake. Based on your responses, Rootiva is not the appropriate resource for your current situation. Please connect with your healthcare provider or specialist team who can best support you right now.' }]
      });
    }

    // ── Tier-specific writing instructions ───────────────────────────────
    const tierWritingInstructions = {
      SIMPLE: `REPORT DEPTH: SIMPLE
Write a focused, warm, practical report. This client needs clarity and motivation — not complexity.
- Keep sections concise. No lengthy physiology explanations.
- Lifestyle section should be the longest and most detailed section.
- Supplements are secondary. Lead with lifestyle always.
- Maximum 3 supplements total.
- Do NOT write deep endocrine theory, advanced adaptogen discussion, or lengthy HPA axis sections.
- Tone: encouraging, realistic, grounded, warm.
- Length: approximately 3-4 pages. Quality over quantity.`,

      MODERATE: `REPORT DEPTH: MODERATE
Write a thorough but focused report. Expand triggered modules selectively.
- Maximum 5 supplements total.
- Balance lifestyle guidance with functional education.
- Tone: intelligent, warm, clinically grounded.
- Length: approximately 5-7 pages.`,

      COMPLEX: `REPORT DEPTH: COMPLEX — FULL PREMIUM ROOTIVA DEPTH
This client warrants comprehensive, integrated analysis.
- Maximum 8 supplements total, carefully prioritized.
- Full cross-system reasoning. Connect patterns across all triggered modules.
- Include deeper physiology where genuinely relevant.
- This is the premium Sarah-style report. Full depth is appropriate.
- Tone: premium, intelligent, deeply personalized, emotionally supportive.
- Length: comprehensive — do not truncate.`
    };

    // ── STAGE 2: Full report ─────────────────────────────────────────────
    const stage2Prompt = `You are Rootiva's functional wellness education AI. Write a complete personalized wellness education report.

You are NOT a medical doctor, licensed healthcare provider, diagnostician, or prescriber.
You ARE a functional wellness educator providing educational information only.

${tierWritingInstructions[tier]}

Use the clinical plan below as your precise foundation. Follow module selections exactly.
Do NOT add modules not listed as TRIGGERED. Do NOT expand MENTION ONLY into full sections.
The client's PRIMARY GOAL drives the entire report architecture.

CLINICAL PLAN:
${stage1Result}

ORIGINAL ROOTIVA MODULE FRAMEWORKS — use these when writing triggered modules:

GUT MODULE — organize using 5R framework when relevant:
Remove (dietary/environmental triggers worth exploring) → Replace (digestive enzyme/acid support) → Reinoculate (probiotic and prebiotic foods) → Repair (gut lining: L-glutamine, zinc carnosine, butyrate) → Rebalance (stress, sleep, lifestyle as foundational regulators). Connect gut to the broader symptom picture. Gut is often the foundation other systems build on.

THYROID MODULE:
Thyroid as metabolic pacemaker. T4-to-T3 conversion when relevant. Levothyroxine timing rules ALWAYS when on thyroid medication. Iodine caution always. Hashimoto's gluten framing: personal decision, not universal mandate.

HPA AXIS MODULE:
NEVER: burned out adrenals, adrenal fatigue. ALWAYS: HPA axis dysregulation, cortisol rhythm disruption, stress-response patterns. Circadian rhythm and light exposure as primary interventions. Nervous system regulation before supplements.

BLOOD SUGAR MODULE:
Meal composition and eating order before supplements. Protein at every meal as foundational. Movement after meals. Chromium cross-check mandatory.

HORMONAL MODULE:
HRT always balanced — valid evidence-supported option. Estrogen dominance: liver and gut clearance. Perimenopause: progesterone declining first. Post-menopause: bone health mandatory.

WEIGHT MANAGEMENT — when weight is primary goal:
Protein (1.6-2g per kg body weight) as foundational satiety and metabolic lever. Fiber for satiety and microbiome. Blood sugar stability as weight regulation mechanism. Protein-forward breakfast within 90 minutes of waking. Both strength training and daily movement. Sleep as metabolic and hormonal regulator. Stress eating patterns if relevant. Realistic sustainable expectations — no extreme approaches.

WRITING RULES — MANDATORY:

BANNED LANGUAGE:
- Critically low → meaningfully below functional optimal
- You have [condition] → may suggest a pattern worth exploring
- Burned out adrenals → HPA axis dysregulation
- Heal your gut → may support gut lining integrity
- Rewire your nervous system → support nervous system regulation
- Push through the fatigue → work within your energy envelope
- Immune boosting → immune regulation support
- You have depression → low mood pattern
- You have anxiety → anxiety and nervous system hyperactivation pattern

NEVER explain the same physiology twice across sections.
ALWAYS use client's actual name throughout.
ALWAYS use actual lab numbers when available.
ALWAYS lead lifestyle before supplements.

FORMATTING:
- ## for major section headings
- ### for sub-headings
- #### for supplement tier labels
- **Supplement Name** — Dose — Rationale — Safety note
- Bullet points with -
- Bold only for supplement names and key warnings
- No tables. Prose in full sentences.

SUPPLEMENT PRESENTATION:
Tier 1 opening: "The following are educational wellness considerations only. Please discuss with your healthcare provider before beginning any new supplement."
Tier 2 opening: "The following are presented as educational awareness items only — not primary recommendations. Individual suitability must be reviewed by a qualified healthcare provider before considering any of the following."
Tier 2 closing: "Your healthcare provider is the right person to help you determine which — if any — of the above considerations are appropriate for your individual picture."
Never duplicate supplements across modules — reference as already noted if repeated.

DRUG INTERACTIONS when relevant:
- Anticoagulants: flag omega-3, quercetin, CoQ10
- SSRIs/SNRIs: note 5-HTP and SAMe excluded
- Levothyroxine: 4-hour separation rule for iron, calcium, magnesium, fiber, coffee
- Statins: CoQ10 education always
- Oral contraceptives: B6, magnesium, zinc, folate, vitamin C depletion note

NEUROPATHY MONITORING when relevant:
- B6 as P5P: "If you experience tingling, numbness, or nerve sensations — discontinue immediately"
- Acetyl-L-Carnitine: "Some individuals report increased nerve sensitivity — discontinue if unusual sensations occur"

REPORT STRUCTURE — exact order:

## Educational Disclaimer
This report is created for educational and wellness purposes only. It does not constitute medical advice, diagnosis, or treatment. All supplement and dietary considerations should be discussed with a qualified healthcare provider before implementation.

## Patient Snapshot
Who this client is, what brought them here, what this report focuses on. Concise.

## What We Found
Use actual numbers. Educational framing only. Scale findings to complexity tier.

## Why You Feel This Way
Warm personalized narrative. Use client's name. Connect findings to lived experience. Reference key connections from clinical plan.

[Triggered module sections only — one ## heading per fully triggered module]
MENTION ONLY modules: one brief paragraph woven into a relevant section, never a standalone heading.

## Nutrition Highlights
Maximum 3-4 considerations. Additions before reductions. Trial language. Diet closing statement.

## Lifestyle Priorities
For SIMPLE cases: this is the most important and detailed section. For all cases: lifestyle before supplements.

## When to See Your Healthcare Provider
Genuine flags only.

## Suggested Labs
Respect tier limits from clinical plan.

## Your 90-Day Wellness Roadmap
Scale to complexity: SIMPLE = Week 1, Month 1, Months 2-3. MODERATE/COMPLEX = Week 1, Weeks 2-4, Month 2, Month 3.

## Continue Your Wellness Journey
"[Client name], your wellness picture is not static. As your labs change and symptoms shift, Rootiva can provide updated educational insights. You may consider returning when you have updated lab results, your symptoms have meaningfully changed, or it has been several months since your last report."

## Educational Disclaimer
This report is created for educational and wellness purposes only. It does not constitute medical advice, diagnosis, or treatment. All supplement and dietary considerations should be discussed with a qualified healthcare provider before implementation.

Write the complete report now. Be warm, clinically thoughtful, and genuinely personalized. The client's primary goal drives everything.`;

    const maxTokens = tier === 'SIMPLE' ? 3000 : tier === 'MODERATE' ? 4500 : 6000;
    const stage2Result = await callClaude(apiKey, [{ role: 'user', content: stage2Prompt }], maxTokens);

    return res.status(200).json({
      content: [{ type: 'text', text: stage2Result }]
    });

  } catch (err) {
    console.error('[Rootiva] Generation error:', err.message);
    return res.status(502).json({
      error: { type: 'generation_error', message: err.message }
    });
  }
});

// ── Health check ───────────────────────────────────────────────────────────
app.get('/health', (req, res) => {
  res.json({ status: 'ok', architecture: '2-stage-adaptive-v2' });
});

app.listen(PORT, () => {
  console.log('[Rootiva] Server running on port ' + PORT + ' — 2-stage adaptive v2');
});
