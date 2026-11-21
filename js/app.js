(function(){
var KEY='springBootCourse.v1';
var store={get:function(){try{return window.localStorage.getItem(KEY)}catch(e){return null}},
 set:function(v){try{window.localStorage.setItem(KEY,v)}catch(e){}},
 del:function(){try{window.localStorage.removeItem(KEY)}catch(e){}}};
var state={};try{state=JSON.parse(store.get()||'{}')||{}}catch(e){state={}}
state.done=state.done||{};state.ex=state.ex||{};state.notes=state.notes||{};state.theme=state.theme||'light';state.cur=state.cur||'home';
function save(){store.set(JSON.stringify(state));}
function $(s){return document.querySelector(s);}
function esc(s){return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');}
function fix(s){return s.replace(/\u00a7\{/g,'${');}   /* section-sign + brace becomes dollar + brace */

var all=[];COURSE.forEach(function(m){m.lessons.forEach(function(l){var o={};for(var k in l)o[k]=l[k];o.mod=m.title;all.push(o);});});
function isReady(l){return !!LESSONS[l.id];}
function readyList(){return all.filter(isReady);}

/* ---------- syntax highlighting (tiny, regex based) ---------- */
var KW={
 java:'abstract|assert|boolean|break|byte|case|catch|char|class|continue|default|do|double|else|enum|extends|final|finally|float|for|if|implements|import|instanceof|int|interface|long|new|package|private|protected|public|record|return|short|static|super|switch|this|throw|throws|try|var|void|while|null|true|false|sealed|permits|yield',
 sql:'select|from|where|insert|into|values|update|set|delete|create|table|alter|drop|index|primary|key|foreign|references|not|null|and|or|join|left|right|inner|on|group|by|order|having|limit|offset|as|distinct|unique|default|varchar|bigint|integer|boolean|timestamp|numeric|text|constraint|if|exists',
 powershell:'if|else|foreach|function|param|return|curl|java|docker|git|cd|echo',
 dockerfile:'from|run|cmd|copy|add|workdir|expose|env|arg|entrypoint|user|volume|healthcheck|as',
 yaml:'true|false|null',json:'true|false|null',properties:'true|false'
};
function hl(code,lang){
 lang=(lang||'').toLowerCase();
 if(lang==='text'||lang===''||!(lang in {java:1,xml:1,yaml:1,yml:1,properties:1,sql:1,json:1,powershell:1,dockerfile:1}))return esc(code);
 if(lang==='yml')lang='yaml';
 var rules=[];
 function add(cls,re){rules.push({cls:cls,src:re});}
 if(lang==='java'||lang==='json')add('c','\\/\\*[\\s\\S]*?\\*\\/|\\/\\/[^\\n]*');
 else if(lang==='xml')add('c','<!--[\\s\\S]*?-->');
 else if(lang==='sql')add('c','--[^\\n]*');
 else add('c','#[^\\n]*');
 if(lang!=='properties')add('s','"(?:\\\\.|[^"\\\\\\n])*"|\'(?:\\\\.|[^\'\\\\\\n])*\'');
 if(lang==='java')add('a','@[A-Za-z_]\\w*');
 if(lang==='xml')add('g','<\\/?[A-Za-z][\\w.:-]*|\\/?>');
 if(lang==='yaml'||lang==='properties')add('y','^[ \\t]*-?[ \\t]*[A-Za-z_][\\w.\\-\\/\\[\\]]*(?=[ \\t]*[:=])');
 add('n','\\b\\d+(?:\\.\\d+)?[LlFfDd]?\\b');
 if(KW[lang])add('k','\\b(?:'+KW[lang]+')\\b');
 if(lang==='java')add('t','\\b[A-Z][A-Za-z0-9_]*\\b');
 var flags='gm'+((lang==='sql'||lang==='dockerfile'||lang==='powershell')?'i':'');
 var re=new RegExp(rules.map(function(r){return '('+r.src+')';}).join('|'),flags);
 var out='',last=0,m;
 while((m=re.exec(code))!==null){
  if(m[0]===''){re.lastIndex++;continue;}
  out+=esc(code.slice(last,m.index));
  var cls='';for(var i=0;i<rules.length;i++){if(m[i+1]!==undefined){cls=rules[i].cls;break;}}
  out+='<span class="tk-'+cls+'">'+esc(m[0])+'</span>';
  last=m.index+m[0].length;
 }
 return out+esc(code.slice(last));
}

/* ---------- tiny markdown renderer ----------
   Fence: ~~~lang optional/path   Inline code: ^code^   Bold: **x** */
function inline(s){
 s=esc(fix(s));
 s=s.replace(/\^([^^]+)\^/g,'<code>$1</code>');
 s=s.replace(/\*\*([^*]+)\*\*/g,'<b>$1</b>');
 return s;
}
var heads=[];
function md(src){
 var L=fix(src).split('\n'),out='',i=0;heads=[];
 while(i<L.length){
  var l=L[i];
  if(l.indexOf('~~~')===0){
   var head=l.slice(3).trim(),sp=head.indexOf(' ');
   var lang=sp>0?head.slice(0,sp):head,path=sp>0?head.slice(sp+1):'',buf=[];i++;
   while(i<L.length&&L[i].indexOf('~~~')!==0){buf.push(L[i]);i++;}i++;
   if(path)out+='<div class="path">'+esc(path)+'</div>';
   out+='<div class="codewrap"><button class="copy">Copy</button><pre><code>'+hl(buf.join('\n'),lang)+'</code></pre></div>';
   continue;
  }
  if(l.charAt(0)==='|'){
   var rows=[];while(i<L.length&&L[i].charAt(0)==='|'){rows.push(L[i]);i++;}
   var cells=function(r){return r.replace(/^\||\|\s*$/g,'').split('|').map(function(c){return c.trim();});};
   out+='<table><tr>'+cells(rows[0]).map(function(c){return '<th>'+inline(c)+'</th>';}).join('')+'</tr>';
   rows.slice(2).forEach(function(r){out+='<tr>'+cells(r).map(function(c){return '<td>'+inline(c)+'</td>';}).join('')+'</tr>';});
   out+='</table>';continue;
  }
  if(/^#{1,4} /.test(l)){
   var n=l.match(/^#+/)[0].length,txt=l.replace(/^#+ /,''),id='h'+heads.length;
   if(n===2||n===3)heads.push({id:id,n:n,t:txt.replace(/\^/g,'')});
   out+='<h'+n+(n===2||n===3?' id="'+id+'"':'')+'>'+inline(txt)+'</h'+n+'>';i++;continue;
  }
  if(l.indexOf('> ')===0){var q=[];while(i<L.length&&L[i].indexOf('> ')===0){q.push(L[i].slice(2));i++;}out+='<blockquote>'+inline(q.join(' '))+'</blockquote>';continue;}
  if(l.trim()==='---'){out+='<hr>';i++;continue;}
  if(/^(- |\d+\. )/.test(l)){
   var ord=/^\d/.test(l),items=[];
   while(i<L.length&&/^(- |\d+\. )/.test(L[i])){items.push(L[i].replace(/^(- |\d+\. )/,''));i++;}
   out+=(ord?'<ol>':'<ul>')+items.map(function(x){return '<li>'+inline(x)+'</li>';}).join('')+(ord?'</ol>':'</ul>');continue;
  }
  if(l.trim()===''){i++;continue;}
  var p=[];while(i<L.length&&L[i].trim()!==''&&!/^(~~~|\||#|> |- |\d+\. |---)/.test(L[i])){p.push(L[i]);i++;}
  if(!p.length){p.push(L[i]);i++;}
  out+='<p>'+inline(p.join(' '))+'</p>';
 }
 return out;
}

/* ---------- views ---------- */
function totalEx(l){var n=0;(LESSONS[l.id].exercises||[]).forEach(function(e){n+=e.tasks.length;});return n;}
function doneEx(l){var n=0;(LESSONS[l.id].exercises||[]).forEach(function(e,ei){e.tasks.forEach(function(t,ti){if(state.ex[l.id+'.'+ei+'.'+ti])n++;});});return n;}
function progress(){
 var r=readyList(),d=r.filter(function(l){return state.done[l.id];}).length,tot=r.length||1;
 $('#barfill').style.width=(d/tot*100)+'%';
 $('#pct').textContent=d+' / '+r.length+' lessons done';
}
function icon(l){return state.done[l.id]?'\u2705':(isReady(l)?'\uD83D\uDCD8':'\uD83D\uDD12');}
function menu(filter){
 filter=(filter||'').toLowerCase();
 var h='<div class="lesson '+(state.cur==='home'?'active':'')+'" data-id="home"><span class="st">\uD83C\uDFE0</span>Course Home</div>';
 COURSE.forEach(function(m){
  var ls=m.lessons.filter(function(l){
   if(!filter)return true;
   var t=(l.id+' '+l.title+' '+m.title).toLowerCase();
   if(t.indexOf(filter)>=0)return true;
   return LESSONS[l.id]&&LESSONS[l.id].md.toLowerCase().indexOf(filter)>=0;
  });
  if(!ls.length)return;
  h+='<div class="mod">'+esc(m.title)+'</div>';
  ls.forEach(function(l){
   h+='<div class="lesson '+(isReady(l)?'':'soon')+' '+(state.cur===l.id?'active':'')+'" data-id="'+l.id+'"><span class="st">'+icon(l)+'</span>'+l.id+' '+esc(l.title)+'</div>';
  });
 });
 $('#menu').innerHTML=h;
 Array.prototype.forEach.call(document.querySelectorAll('.lesson'),function(e){e.onclick=function(){go(e.getAttribute('data-id'));};});
}
function go(id){state.cur=id;save();render();window.scrollTo(0,0);}

function home(){
 var r=readyList(),d=r.filter(function(l){return state.done[l.id];}).length;
 var exT=0,exD=0;r.forEach(function(l){exT+=totalEx(l);exD+=doneEx(l);});
 var next=r.filter(function(l){return !state.done[l.id];})[0];
 var h='<div class="hero"><img src="images/icon-192.png" alt=""><div><h1 style="margin:0">Spring Boot: 0 to Hero</h1><div style="color:var(--muted)">From Java and Spring fundamentals to secured, tested, containerized services.</div></div></div>';
 h+='<div class="stats"><div class="stat"><b>'+d+'/'+all.length+'</b>lessons completed</div><div class="stat"><b>'+exD+'/'+exT+'</b>exercise tasks done</div><div class="stat"><b>'+COURSE.length+'</b>modules</div></div>';
 if(next)h+='<p><button data-go="'+next.id+'">'+(d?'Continue':'Start')+' with Lesson '+next.id+': '+esc(next.title)+' \u2192</button></p>';
 else h+='<div class="card">\uD83C\uDF89 You finished every lesson. Now build something of your own!</div>';
 COURSE.forEach(function(m){
  var mr=m.lessons.filter(isReady),md_=mr.filter(function(l){return state.done[l.id];}).length;
  h+='<div class="card"><b>'+esc(m.title)+'</b><div class="mbar"><div style="width:'+(mr.length?md_/mr.length*100:0)+'%"></div></div>';
  m.lessons.forEach(function(l){h+='<div style="margin-top:6px">'+icon(l)+' <a href="#" data-go="'+l.id+'">'+l.id+'</a> '+esc(l.title)+'</div>';});
  h+='</div>';
 });
 return h;
}
function lesson(l){
 var data=LESSONS[l.id];
 var h='<span class="pill">'+esc(l.mod)+'</span><span class="pill">Lesson '+l.id+'</span><h1>'+esc(l.title)+'</h1>';
 if(!data)return h+'<div class="card">\uD83D\uDD12 This lesson file was not found (js/lessons/lesson-'+l.id+'.js).</div>';
 var body=md(data.md);
 if(heads.length){
  h+='<div class="toc"><b>On this page</b>';
  heads.forEach(function(x){h+='<a href="#" class="'+(x.n===3?'sub':'')+'" data-scroll="'+x.id+'">'+esc(x.t)+'</a>';});
  h+='</div>';
 }
 h+=body+'<h2>\uD83C\uDFCB\uFE0F Hands-On Practice Exercises</h2>';
 (data.exercises||[]).forEach(function(e,ei){
  h+='<div class="ex"><h4>'+inline(e.title)+'</h4>';
  e.tasks.forEach(function(t,ti){
   var k=l.id+'.'+ei+'.'+ti,c=state.ex[k];
   h+='<label><input type="checkbox" data-ex="'+k+'" '+(c?'checked':'')+'><span class="'+(c?'done':'')+'">'+inline(t)+'</span></label>';
  });
  h+='</div>';
 });
 h+='<p style="color:var(--muted)">Solutions are not included. Ask your instructor to review your code or reveal a solution.</p>';
 h+='<h2>\uD83D\uDCDD My Notes</h2><textarea id="notes" placeholder="Notes, errors, questions...">'+esc(state.notes[l.id]||'')+'</textarea>';
 var idx=-1;for(var i=0;i<all.length;i++){if(all[i].id===l.id)idx=i;}
 var prev=all[idx-1],next=all[idx+1];
 h+='<div class="footer"><button class="ghost" '+(prev?'data-go="'+prev.id+'"':'disabled')+'>\u2190 Previous</button>'+
    '<button id="mark">'+(state.done[l.id]?'\u21BA Mark as not done':'\u2705 Mark lesson complete')+'</button>'+
    '<button class="ghost" '+(next?'data-go="'+next.id+'"':'disabled')+'>Next \u2192</button></div>';
 return h;
}
function render(){
 var l=null;for(var i=0;i<all.length;i++){if(all[i].id===state.cur)l=all[i];}
 $('#main').innerHTML=l?lesson(l):home();
 menu($('#search').value);progress();
 Array.prototype.forEach.call(document.querySelectorAll('[data-go]'),function(e){e.onclick=function(ev){ev.preventDefault();go(e.getAttribute('data-go'));};});
 Array.prototype.forEach.call(document.querySelectorAll('[data-scroll]'),function(e){e.onclick=function(ev){ev.preventDefault();var t=document.getElementById(e.getAttribute('data-scroll'));if(t)t.scrollIntoView({behavior:'smooth'});};});
 Array.prototype.forEach.call(document.querySelectorAll('.copy'),function(b){b.onclick=function(){
  var txt=b.nextSibling.textContent;
  try{navigator.clipboard.writeText(txt);}catch(e){}
  b.textContent='Copied!';setTimeout(function(){b.textContent='Copy';},1200);};});
 Array.prototype.forEach.call(document.querySelectorAll('[data-ex]'),function(c){c.onchange=function(){state.ex[c.getAttribute('data-ex')]=c.checked;save();c.nextSibling.className=c.checked?'done':'';progress();};});
 var n=$('#notes');if(n&&l)n.oninput=function(){state.notes[l.id]=n.value;save();};
 var m=$('#mark');if(m&&l)m.onclick=function(){state.done[l.id]=!state.done[l.id];save();render();};
}
$('#search').oninput=function(e){menu(e.target.value);};
$('#theme').onclick=function(){state.theme=state.theme==='dark'?'light':'dark';document.documentElement.setAttribute('data-theme',state.theme);save();};
$('#reset').onclick=function(){if(confirm('Erase all progress and notes?')){store.del();state={done:{},ex:{},notes:{},theme:'light',cur:'home'};document.documentElement.setAttribute('data-theme','light');render();}};
document.documentElement.setAttribute('data-theme',state.theme);
render();
})();
