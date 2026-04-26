import 'dotenv/config';
import { S3Client, ListObjectsV2Command } from '@aws-sdk/client-s3';

const bucketName = process.env.REMOTION_BUCKET_NAME!;
const s3 = new S3Client({
    region: 'us-east-1',
    credentials: {
        accessKeyId: process.env.REMOTION_AWS_ACCESS_KEY_ID!,
        secretAccessKey: process.env.REMOTION_AWS_SECRET_ACCESS_KEY!,
    },
});

const windowMinutes = Number(process.argv[2] || 30);

for (const prefix of ['renders/', 'custom-renders/']) {
    console.log(`\n=== ${prefix} (last ${windowMinutes} min) ===`);
    const list = await s3.send(new ListObjectsV2Command({ Bucket: bucketName, Prefix: prefix, MaxKeys: 1000 }));
    const recent = (list.Contents || [])
        .filter(obj => obj.LastModified && (Date.now() - obj.LastModified.getTime()) < windowMinutes * 60 * 1000)
        .sort((a, b) => (b.LastModified?.getTime() || 0) - (a.LastModified?.getTime() || 0));
    console.log(`${recent.length} objects modified in last ${windowMinutes}min`);
    for (const obj of recent.slice(0, 50)) {
        console.log(`  ${obj.Key} ${obj.Size}b ${obj.LastModified?.toISOString()}`);
    }
}
