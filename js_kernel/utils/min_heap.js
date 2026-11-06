'use strict';
// A priority queue is shared infrastructure; each navigator owns its graph and its score.
class MinHeap {
  constructor() { this.data = []; }
  get size() { return this.data.length; }
  push(node) {
    const a = this.data;
    a.push(node);
    let i = a.length-1;
    while (i > 0) {
      const p = (i-1)>>1;
      if (a[i].f >= a[p].f) break;
      [a[i],a[p]] = [a[p],a[i]]; i = p;
    }
  }
  pop() {
    const a = this.data, first = a[0], last = a.pop();
    if (a.length) {
      a[0] = last;
      let i = 0;
      while (true) {
        let next = i;
        const l = 2*i+1, r = l+1;
        if (l < a.length && a[l].f < a[next].f) next=l;
        if (r < a.length && a[r].f < a[next].f) next=r;
        if (next===i) break;
        [a[next],a[i]]=[a[i],a[next]]; i=next;
      }
    }
    return first;
  }
}
module.exports = { MinHeap };
