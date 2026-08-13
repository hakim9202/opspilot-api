import { PrismaClient } from '@prisma/client';
import { LAB_PLANS } from '../src/modules/licensing/plans';

const prisma = new PrismaClient();

async function main() {
  const token = process.env.LAB_INSTALL_TOKEN || 'install_lab_opspilot_mvp';
  const free = LAB_PLANS.free;

  const org = await prisma.organization.upsert({
    where: { slug: 'lab' },
    update: {
      name: 'OpsPilot Lab',
      plan: free.id,
      maxClusters: free.maxClusters,
      status: 'active',
    },
    create: {
      name: 'OpsPilot Lab',
      slug: 'lab',
      plan: free.id,
      maxClusters: free.maxClusters,
      status: 'active',
    },
  });

  await prisma.installToken.upsert({
    where: { token },
    update: {
      active: true,
      label: 'lab',
      organizationId: org.id,
    },
    create: {
      token,
      label: 'lab',
      active: true,
      organizationId: org.id,
    },
  });

  console.log(`Seeded org "${org.slug}" plan=${org.plan} maxClusters=${org.maxClusters}`);
  console.log(`Seeded install token: ${token}`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
