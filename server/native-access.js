export async function rfqAccess(db,user,rfqId){
  if(!user)return null;
  const rfq=await db.prepare('SELECT * FROM rfqs WHERE id=?').bind(rfqId).first();if(!rfq)return null;
  const client=rfq.client_company_id?await db.prepare('SELECT * FROM companies WHERE id=?').bind(rfq.client_company_id).first():null;
  const owner=client?.owner_user_id===user.id||user.role==='public_owner'&&user.public_request_id===rfq.public_request_id;
  const vendor=user.role==='vendor'?await db.prepare("SELECT * FROM companies WHERE owner_user_id=? AND role='vendor' AND verification_status='verified'").bind(user.id).first():null;
  const invited=vendor&&['quoting','awarded'].includes(rfq.status)?await db.prepare('SELECT id FROM rfq_invitations WHERE rfq_id=? AND vendor_company_id=?').bind(rfq.id,vendor.id).first():null;
  if(!owner&&user.role!=='admin'&&!invited)return null;
  return {rfq,client,owner,admin:user.role==='admin',vendor,invited:!!invited};
}
