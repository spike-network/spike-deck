export function chronological(records, ascending = true) {
  return records.slice().sort((left,right)=>(ascending?1:-1)*
    (left.occurred_at_unix_ms-right.occurred_at_unix_ms || left.sequence-right.sequence));
}

export function serializeJournal(records, json) {
  const lines = chronological(records).map(record=>{
    if (json) return JSON.stringify(record);
    const date=new Date(record.occurred_at_unix_ms);
    const timestamp=Number.isNaN(date.valueOf())?'—':date.toISOString();
    const fields=record.fields ?? record.data;
    return `${timestamp} ${(record.level ?? record.severity ?? '').toUpperCase()} ${record.target ?? record.kind ?? ''} ${record.message ?? record.summary ?? ''}${fields==null?'':' '+JSON.stringify(fields)}`.replaceAll('\n','\n    ');
  });
  return lines.length ? lines.join('\n')+'\n' : '';
}

export function downloadJournal(records, json, name) {
  const url=URL.createObjectURL(new Blob([serializeJournal(records,json)],{type:json?'application/x-ndjson':'text/plain;charset=utf-8'}));
  const link=document.createElement('a');
  try {
    link.href=url;link.download=`${name}.${json?'jsonl':'txt'}`;
    document.body.appendChild(link);link.click();
  } finally {
    link.remove();setTimeout(()=>URL.revokeObjectURL(url),0);
  }
}
