const { execSync } = require('child_process');

try {
  // Get site ID
  const siteInfoStr = execSync('npx netlify status --json').toString();
  const siteInfo = JSON.parse(siteInfoStr);
  const siteId = siteInfo.siteData['site-id'];
  console.log(`Site ID: ${siteId}`);

  // Get all deploys
  const deploysStr = execSync(`npx netlify api listSiteDeploys --data "{ \\"site_id\\": \\"${siteId}\\" }" `).toString();
  const deploys = JSON.parse(deploysStr);
  console.log(`Found ${deploys.length} total deploys.`);

  if (deploys.length <= 1) {
    console.log("No old deploys to delete.");
    process.exit(0);
  }

  // Keep the newest (first one)
  const deploysToDelete = deploys.slice(1);
  console.log(`Deleting ${deploysToDelete.length} old deploys...`);

  let successCount = 0;
  let failCount = 0;

  for (const deploy of deploysToDelete) {
    try {
      console.log(`Deleting deploy ${deploy.id} (State: ${deploy.state}, Created: ${deploy.created_at})...`);
      execSync(`npx netlify api deleteDeploy --data "{ \\"deploy_id\\": \\"${deploy.id}\\" }"`);
      successCount++;
    } catch (e) {
      console.error(`Failed to delete deploy ${deploy.id}:`, e.message);
      failCount++;
    }
  }

  console.log(`Done! Deleted: ${successCount}, Failed: ${failCount}. Kept the most recent deploy: ${deploys[0].id}`);
} catch (error) {
  console.error("Error:", error.message);
}
