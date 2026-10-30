// infrastructure/db/seed.data.ts
// Static seed values kept apart from seed.ts so tests can pin them to design §4
// and §10 without a database or a generated Prisma client.

export const seedData = {
  roles: [
    { name: 'AI Product Manager - Trading & Wealth', refApplicantCount: 33 },
    { name: 'Product Management', refApplicantCount: 118 },
    { name: 'Customer Data Analytics & Engagement Specialist (CleverTap)', refApplicantCount: 16 },
    { name: 'Data Science / ML Engineer', refApplicantCount: 106 },
    { name: 'Backend Engineer', refApplicantCount: 36 },
    { name: 'Algo & Quant Profile', refApplicantCount: 42 },
    { name: 'AI & ML Engineer', refApplicantCount: 110 },
  ],
  // Disabled placeholders: the Super Admin enters real credentials in
  // Settings -> Integrations. Secret fields stay blank until then.
  configs: [
    {
      key: 'sms.arihant',
      isSecret: true,
      value: {
        enabled: false,
        baseUrl: 'https://arihantapi.arihantcapital.com/V1/api/Media/sendSMS',
        authToken: '',
        userName: '',
        apiKey: '',
        otpTemplate: 'Your Arihant Capital assessment OTP is {otp}. Valid for 5 minutes.',
      },
    },
    {
      key: 'email.zatpatmail',
      isSecret: true,
      value: {
        enabled: false,
        baseUrl: 'https://api.zatpatmail.com',
        sendMailToken: '',
        fromAddress: '',
        fromName: 'Arihant Capital Recruitment',
        replyTo: '',
      },
    },
  ],
  demo: {
    roleName: 'Backend Engineer',
    candidates: [
      { candidateCode: 'DEMO001', fullName: 'Demo Candidate One', email: 'demo1@example.com', mobile: '9000000001' },
      { candidateCode: 'DEMO002', fullName: 'Demo Candidate Two', email: 'demo2@example.com', mobile: '9000000002' },
      { candidateCode: 'DEMO003', fullName: 'Demo Candidate Three', email: 'demo3@example.com', mobile: '9000000003' },
    ],
    questions: [
      {
        text: 'Explain how you would design an idempotent order-placement API for a trading platform.',
        maxMarks: 10,
        evaluatorGuidance: 'Look for idempotency keys, retries, and exactly-once side effects.',
      },
      {
        text: 'Describe how you would find and fix a slow PostgreSQL query in production.',
        maxMarks: 10,
        evaluatorGuidance: 'Look for EXPLAIN ANALYZE, indexing, and lock awareness.',
      },
    ],
  },
} as const;
