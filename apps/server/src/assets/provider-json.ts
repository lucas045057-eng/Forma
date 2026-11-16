/** Quote integer tokens before parsing, never after IEEE754 has rounded an int64 task id. */
export function parseProviderJson(text:string):unknown {
 let output='',index=0;
 while(index<text.length){
  const start=index,char=text[index];
  if(char==='"'){
   index++;while(index<text.length){if(text[index]==='\\'){index+=2;continue;}if(text[index++]==='"')break;}output+=text.slice(start,index);continue;
  }
  if(char==='-'||(char>='0'&&char<='9')){
   while(index<text.length&&/[0-9eE+.-]/.test(text[index]))index++;
   const token=text.slice(start,index);
   output+=/^-?\d+$/.test(token)&&!Number.isSafeInteger(Number(token))?JSON.stringify(token):token;continue;
  }
  output+=char;index++;
 }
 return JSON.parse(output);
}
