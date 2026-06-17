// fixtures.js
// OFFLINE stand-in recipe packs for the Vanta "Mode B" method runner.
//
// These let the runner (recipe -> prompt -> Gemini -> schema-validate) be built
// and tested before the real Vanta /recipe endpoint + app token are live. When
// env.VANTA_BASE + env.VANTA_APP_TOKEN are set, getRecipe() fetches the REAL
// pack from Vanta and these are ignored. The shapes here mirror the contract
// ({ id, version, contentHash, recipe, inputSchema, outputSchema, examples })
// but the recipe text / schemas are synthetic placeholders — the live method
// definitions are the source of truth.

export const FIXTURES = {
  'estimating-email-classify': {
    id: 'estimating-email-classify',
    version: '1.0.0',
    contentHash: 'fixture-classify-1',
    recipe: 'You classify one inbound email for a construction estimator into exactly one type. quote = a supplier sent a price. quote-questions = a supplier is asking questions before quoting. job-related = relevant to a job but not a quote or question. unrelated = nothing to do with our jobs. spam = junk / phishing. Give a short reason.',
    inputSchema: {
      type: 'object',
      properties: { subject: { type: 'string' }, fromEmail: { type: 'string' }, bodyText: { type: 'string' } },
      required: ['subject', 'bodyText']
    },
    outputSchema: {
      type: 'object',
      properties: {
        type: { type: 'string', enum: ['quote', 'quote-questions', 'job-related', 'unrelated', 'spam'] },
        reason: { type: 'string' }
      },
      required: ['type', 'reason']
    },
    examples: [
      { source: 'synthetic', input: { subject: 'Re: RFQ Roof Plumbing 31 Langford', bodyText: 'Our price for the roof plumbing is $12,400 inc GST.' }, output: { type: 'quote', reason: 'Supplier supplied a total price.' } },
      { source: 'synthetic', input: { subject: 'Re: RFQ Balustrade', bodyText: 'Can you send the drawings before I price this?' }, output: { type: 'quote-questions', reason: 'Supplier is asking for drawings before quoting.' } }
    ]
  },

  'estimating-quote-match': {
    id: 'estimating-quote-match',
    version: '1.0.0',
    contentHash: 'fixture-match-1',
    recipe: 'Given a supplier email and the list of RFQs we have sent, decide which of our RFQs this email is replying to, and where the price is (email body, an attachment, or a forwarded accounting-app email). Return the matched RFQ id or null if none fits.',
    inputSchema: {
      type: 'object',
      properties: {
        subject: { type: 'string' }, bodyText: { type: 'string' },
        sentRfqs: { type: 'array', items: { type: 'object' } }
      },
      required: ['sentRfqs']
    },
    outputSchema: {
      type: 'object',
      properties: {
        matchedRfqId: { type: ['string', 'null'] },
        confidence: { type: 'number' },
        priceLocation: { type: 'string', enum: ['body', 'attachment', 'forwarded', 'none'] },
        reason: { type: 'string' }
      },
      required: ['matchedRfqId', 'confidence', 'priceLocation']
    },
    examples: [
      { source: 'synthetic', input: { subject: 'Re: RFQ Roof Plumbing', bodyText: 'Price attached.', sentRfqs: [{ rfqId: 'rfq-1', category: 'Roof Plumbing' }] }, output: { matchedRfqId: 'rfq-1', confidence: 0.9, priceLocation: 'attachment', reason: 'Subject + category match; PDF attached.' } }
    ]
  },

  'estimating-quote-questions': {
    id: 'estimating-quote-questions',
    version: '1.1.0',
    contentHash: 'fixture-questions-1',
    recipe: 'A supplier is asking questions instead of quoting. Pull out their questions, draft a reply answering the ones you can from the job context, and flag the ones you are not sure about so the estimator can fill them in.',
    inputSchema: {
      type: 'object',
      properties: { bodyText: { type: 'string' }, jobContext: { type: 'string' } },
      required: ['bodyText']
    },
    outputSchema: {
      type: 'object',
      properties: {
        questions: { type: 'array', items: { type: 'string' } },
        draftReply: { type: 'string' },
        uncertain: { type: 'array', items: { type: 'string' } }
      },
      required: ['questions', 'draftReply']
    },
    examples: [
      { source: 'synthetic', input: { bodyText: 'What colour is the Colorbond, and when do you need it by?', jobContext: 'Colour: Monument.' }, output: { questions: ['What colour is the Colorbond?', 'When is it needed by?'], draftReply: 'Hi, the Colorbond colour is Monument. I will confirm the required date shortly.', uncertain: ['Required completion date'] } }
    ]
  },

  'estimating-quote-analysis': {
    id: 'estimating-quote-analysis',
    version: '1.1.0',
    contentHash: 'fixture-analysis-1',
    recipe: 'Analyse a supplier quote (derived text only). Return the company, the headline amount, whether GST is included, how well it covers our scope, any exclusions, and a short note.',
    inputSchema: {
      type: 'object',
      properties: { quoteText: { type: 'string' }, ourScope: { type: 'string' } },
      required: ['quoteText']
    },
    outputSchema: {
      type: 'object',
      properties: {
        company: { type: 'string' },
        amount: { type: ['number', 'null'] },
        gstIncluded: { type: ['boolean', 'null'] },
        scopeCoverage: { type: 'string', enum: ['full', 'partial', 'unsure'] },
        exclusions: { type: 'array', items: { type: 'string' } },
        note: { type: 'string' }
      },
      required: ['company', 'amount', 'scopeCoverage']
    },
    examples: [
      { source: 'synthetic', input: { quoteText: 'ABC Roofing — total $12,400 inc GST. Excludes scaffolding.', ourScope: 'Supply + install roof plumbing incl flashings.' }, output: { company: 'ABC Roofing', amount: 12400, gstIncluded: true, scopeCoverage: 'partial', exclusions: ['Scaffolding'], note: 'Scaffolding excluded; flashings not confirmed.' } }
    ]
  }
};
